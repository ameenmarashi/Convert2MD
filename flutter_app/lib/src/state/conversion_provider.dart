
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/conversion.dart';
import '../core/converter_registry.dart';

/// One row in the results list.
sealed class ConversionEntry {
  const ConversionEntry({required this.id, required this.name});

  final int id;
  final String name;
}

class PendingEntry extends ConversionEntry {
  const PendingEntry({required super.id, required super.name});
}

class SuccessEntry extends ConversionEntry {
  const SuccessEntry({required super.id, required super.name, required this.result});

  final ConversionResult result;
}

class FailedEntry extends ConversionEntry {
  const FailedEntry({required super.id, required super.name, required this.error});

  final String error;
}

class _WorkItem {
  const _WorkItem(this.name, this.bytes, this.options);

  final String name;
  final Uint8List bytes;
  final ConvertOptions options;
}

/// Conversion runs on a background isolate so a 300-page PDF never blocks the
/// UI thread — the same reason the web app uses a Web Worker.
Future<ConversionResult> _convertInIsolate(_WorkItem item) {
  return compute(_convertEntryPoint, item);
}

ConversionResult _convertEntryPoint(_WorkItem item) {
  return convertFile(
    SourceFile(name: item.name, bytes: item.bytes),
    item.options,
  );
}

class ConversionNotifier extends StateNotifier<List<ConversionEntry>> {
  ConversionNotifier() : super(const []);

  int _sequence = 0;

  Future<void> addFiles(List<({String name, Uint8List bytes})> files, ConvertOptions options) async {
    for (final file in files) {
      await _convertOne(file.name, file.bytes, options);
    }
  }

  Future<void> _convertOne(String name, Uint8List bytes, ConvertOptions options) async {
    final id = ++_sequence;
    state = [...state, PendingEntry(id: id, name: name)];

    try {
      final result = await _convertInIsolate(_WorkItem(name, bytes, options));
      _replace(id, SuccessEntry(id: id, name: name, result: result));
    } on ConversionException catch (error) {
      _replace(id, FailedEntry(id: id, name: name, error: error.message));
    } catch (error) {
      _replace(id, FailedEntry(id: id, name: name, error: error.toString()));
    }
  }

  void _replace(int id, ConversionEntry entry) {
    state = [
      for (final existing in state)
        if (existing.id == id) entry else existing,
    ];
  }

  void remove(int id) {
    state = state.where((entry) => entry.id != id).toList();
  }

  void clear() {
    state = const [];
  }
}

final conversionProvider =
    StateNotifierProvider<ConversionNotifier, List<ConversionEntry>>((ref) {
  return ConversionNotifier();
});

final successfulResultsProvider = Provider<List<ConversionResult>>((ref) {
  return ref
      .watch(conversionProvider)
      .whereType<SuccessEntry>()
      .map((entry) => entry.result)
      .toList();
});
