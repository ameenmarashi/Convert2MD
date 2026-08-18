import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/app_localizations.dart';
import '../state/conversion_provider.dart';
import '../state/settings_provider.dart';
import 'file_service.dart';
import 'result_card.dart';
import 'settings_sheet.dart';

class HomePage extends ConsumerWidget {
  const HomePage({super.key});

  static const FileService _files = FileService();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final entries = ref.watch(conversionProvider);
    final wide = MediaQuery.sizeOf(context).width >= 720;

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(l10n.appTitle, style: Theme.of(context).textTheme.titleMedium),
            Text(
              l10n.appTagline,
              style: Theme.of(context).textTheme.labelSmall,
              overflow: TextOverflow.ellipsis,
            ),
          ],
        ),
        actions: [
          if (entries.isNotEmpty)
            IconButton(
              icon: const Icon(Icons.delete_sweep_outlined),
              tooltip: l10n.clearAll,
              onPressed: () => ref.read(conversionProvider.notifier).clear(),
            ),
          IconButton(
            icon: const Icon(Icons.tune),
            tooltip: l10n.settings,
            onPressed: () => showSettingsSheet(context),
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 900),
            child: ListView.builder(
              padding: EdgeInsets.fromLTRB(wide ? 24 : 12, 12, wide ? 24 : 12, 32),
              itemCount: entries.length + 1,
              itemBuilder: (context, index) {
                if (index == 0) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      PickerCard(onPick: () => _pick(context, ref)),
                      const SizedBox(height: 16),
                      if (entries.isEmpty) EmptyState(message: l10n.emptyState),
                    ],
                  );
                }
                return Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: ResultCard(entry: entries[index - 1]),
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _pick(BuildContext context, WidgetRef ref) async {
    final files = await _files.pickFiles();
    if (files.isEmpty) return;
    final options = ref.read(settingsProvider).options;
    await ref.read(conversionProvider.notifier).addFiles(files, options);
  }
}

class PickerCard extends StatelessWidget {
  const PickerCard({required this.onPick, super.key});

  final VoidCallback onPick;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final scheme = Theme.of(context).colorScheme;

    return Card(
      child: InkWell(
        onTap: onPick,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 20),
          child: Column(
            children: [
              Icon(Icons.file_open_outlined, size: 44, color: scheme.primary),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: onPick,
                icon: const Icon(Icons.add),
                label: Text(l10n.chooseFiles),
              ),
              const SizedBox(height: 12),
              Text(
                l10n.dropHint,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 6),
              Text(
                l10n.privacyNote,
                textAlign: TextAlign.center,
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({required this.message, super.key});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48),
      child: Center(
        child: Text(
          message,
          style: Theme.of(context)
              .textTheme
              .bodyMedium
              ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
        ),
      ),
    );
  }
}
