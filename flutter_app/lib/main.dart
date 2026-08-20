import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'l10n/app_localizations.dart';
import 'src/state/settings_provider.dart';
import 'src/ui/home_page.dart';

void main() {
  runApp(const ProviderScope(child: MdConverterApp()));
}

class MdConverterApp extends ConsumerWidget {
  const MdConverterApp({super.key});

  /// Palette from ../../brand.json, the same one the PWA's CSS tokens use.
  static const Color _accentLight = Color(0xFF1FA383);
  static const Color _accentDark = Color(0xFF52D2A8);
  static const Color _navy = Color(0xFF0F2436);
  static const Color _surfaceLight = Color(0xFFE9F4F3);
  static const Color _surfaceDark = Color(0xFF0E1B28);

  /// The Rx Suite family sets everything in IBM Plex Mono; the bundled faces
  /// are declared in pubspec.yaml.
  static const String _fontFamily = 'IBM Plex Mono';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final settings = ref.watch(settingsProvider);

    return MaterialApp(
      onGenerateTitle: (context) => AppLocalizations.of(context).appTitle,
      debugShowCheckedModeBanner: false,
      themeMode: settings.themeMode,
      locale: settings.locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: _theme(Brightness.light),
      darkTheme: _theme(Brightness.dark),
      home: const HomePage(),
    );
  }

  ThemeData _theme(Brightness brightness) {
    final dark = brightness == Brightness.dark;
    final accent = dark ? _accentDark : _accentLight;
    // Seeded so every derived Material role stays harmonious, then the handful
    // of roles the eye actually reads are pinned to the brand values.
    final scheme = ColorScheme.fromSeed(seedColor: accent, brightness: brightness).copyWith(
      primary: accent,
      onPrimary: dark ? const Color(0xFF0A1520) : const Color(0xFF0A1C2B),
      surface: dark ? _surfaceDark : _surfaceLight,
      onSurface: dark ? const Color(0xFFE4F0EE) : _navy,
      surfaceContainerLowest: dark ? const Color(0xFF0A1520) : const Color(0xFFFBFDFD),
      surfaceContainerHighest: dark ? const Color(0xFF16273A) : const Color(0xFFDDEDEB),
      outlineVariant: dark ? const Color(0xFF25405A) : const Color(0xFFCFE4E0),
    );
    return ThemeData(
      colorScheme: scheme,
      useMaterial3: true,
      fontFamily: _fontFamily,
      scaffoldBackgroundColor: scheme.surface,
      visualDensity: VisualDensity.adaptivePlatformDensity,
      cardTheme: CardThemeData(
        elevation: 0,
        clipBehavior: Clip.antiAlias,
        // 12px matches the PWA's --radius token, so cards read the same on both.
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: scheme.outlineVariant),
        ),
      ),
      // Rounded rectangles rather than Material's default full-pill shape, to
      // match the PWA's flatter, more minimal --radius-sm buttons.
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, 48),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
      segmentedButtonTheme: SegmentedButtonThemeData(
        style: SegmentedButton.styleFrom(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
        ),
      ),
    );
  }
}
