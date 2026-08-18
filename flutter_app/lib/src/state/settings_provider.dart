import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/conversion.dart';

/// Persisted app settings: conversion options, theme mode and locale override.
class Settings {
  const Settings({
    this.options = const ConvertOptions(),
    this.themeMode = ThemeMode.system,
    this.localeCode,
  });

  final ConvertOptions options;
  final ThemeMode themeMode;

  /// `null` follows the device language.
  final String? localeCode;

  Locale? get locale => localeCode == null ? null : Locale(localeCode!);

  Settings copyWith({ConvertOptions? options, ThemeMode? themeMode, String? localeCode, bool clearLocale = false}) {
    return Settings(
      options: options ?? this.options,
      themeMode: themeMode ?? this.themeMode,
      localeCode: clearLocale ? null : (localeCode ?? this.localeCode),
    );
  }

  Map<String, Object?> toJson() => {
        'options': options.toJson(),
        'themeMode': themeMode.name,
        'localeCode': localeCode,
      };

  factory Settings.fromJson(Map<String, Object?> json) {
    final rawOptions = json['options'];
    return Settings(
      options: rawOptions is Map
          ? ConvertOptions.fromJson(rawOptions.cast<String, Object?>())
          : const ConvertOptions(),
      themeMode: ThemeMode.values.firstWhere(
        (mode) => mode.name == json['themeMode'],
        orElse: () => ThemeMode.system,
      ),
      localeCode: json['localeCode'] as String?,
    );
  }
}

const String _storageKey = 'md-converter.settings';

class SettingsNotifier extends StateNotifier<Settings> {
  SettingsNotifier() : super(const Settings()) {
    unawaited(_load());
  }

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final stored = prefs.getString(_storageKey);
      if (stored == null) return;
      final decoded = jsonDecode(stored);
      if (decoded is Map) state = Settings.fromJson(decoded.cast<String, Object?>());
    } catch (_) {
      // Corrupt or unavailable storage: keep the defaults.
    }
  }

  Future<void> _persist() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_storageKey, jsonEncode(state.toJson()));
    } catch (_) {
      // Settings simply stay session-only when storage is unavailable.
    }
  }

  void updateOptions(ConvertOptions options) {
    state = state.copyWith(options: options);
    unawaited(_persist());
  }

  void setThemeMode(ThemeMode mode) {
    state = state.copyWith(themeMode: mode);
    unawaited(_persist());
  }

  void setLocale(String? code) {
    state = code == null ? state.copyWith(clearLocale: true) : state.copyWith(localeCode: code);
    unawaited(_persist());
  }
}

final settingsProvider = StateNotifierProvider<SettingsNotifier, Settings>((ref) {
  return SettingsNotifier();
});

/// Fire-and-forget helper that keeps the `unawaited_futures` lint satisfied.
void unawaited(Future<void> future) {
  future.ignore();
}
