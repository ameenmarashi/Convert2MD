import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/app_localizations.dart';
import '../core/conversion.dart';
import '../state/conversion_provider.dart';
import 'file_service.dart';

class ResultCard extends ConsumerStatefulWidget {
  const ResultCard({required this.entry, super.key});

  final ConversionEntry entry;

  @override
  ConsumerState<ResultCard> createState() => _ResultCardState();
}

class _ResultCardState extends ConsumerState<ResultCard> {
  static const FileService _files = FileService();

  bool _showSource = false;

  @override
  Widget build(BuildContext context) {
    return switch (widget.entry) {
      PendingEntry(:final name) => _PendingCard(name: name),
      FailedEntry(:final name, :final error) => _FailedCard(
          name: name,
          error: error,
          onRemove: () => ref.read(conversionProvider.notifier).remove(widget.entry.id),
        ),
      SuccessEntry(:final result) => _buildSuccess(context, result),
    };
  }

  Widget _buildSuccess(BuildContext context, ConversionResult result) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 14, 8, 8),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(result.outputName, style: theme.textTheme.titleSmall),
                      const SizedBox(height: 2),
                      Text(
                        [
                          result.format,
                          l10n.statsWords(result.wordCount),
                          if (result.imageCount > 0) l10n.statsImages(result.imageCount),
                          l10n.statsDuration(result.durationMs),
                        ].join(' · '),
                        style: theme.textTheme.bodySmall
                            ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.close),
                  tooltip: l10n.remove,
                  onPressed: () => ref.read(conversionProvider.notifier).remove(widget.entry.id),
                ),
              ],
            ),
          ),
          if (result.warnings.isNotEmpty) _WarningsBox(warnings: result.warnings),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  onPressed: () => _copy(result),
                  icon: const Icon(Icons.copy_all_outlined, size: 18),
                  label: Text(l10n.copy),
                ),
                FilledButton.icon(
                  onPressed: () => _save(result),
                  icon: Icon(FileService.isDesktop ? Icons.save_alt : Icons.ios_share, size: 18),
                  label: Text(FileService.isDesktop ? l10n.save : l10n.share),
                ),
                SegmentedButton<bool>(
                  showSelectedIcon: false,
                  segments: [
                    ButtonSegment(value: false, label: Text(l10n.preview)),
                    ButtonSegment(value: true, label: Text(l10n.markdownSource)),
                  ],
                  selected: {_showSource},
                  onSelectionChanged: (selection) =>
                      setState(() => _showSource = selection.first),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 420),
            child: _showSource
                ? _SourceView(markdown: result.markdown)
                : Markdown(
                    data: result.markdown,
                    selectable: true,
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
                    shrinkWrap: true,
                  ),
          ),
        ],
      ),
    );
  }

  Future<void> _copy(ConversionResult result) async {
    await Clipboard.setData(ClipboardData(text: result.markdown));
    if (!mounted) return;
    final l10n = AppLocalizations.of(context);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(l10n.copied)));
  }

  Future<void> _save(ConversionResult result) async {
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    try {
      final path = await _files.save(result.outputName, result.markdown);
      if (path == null || !mounted) return;
      if (FileService.isDesktop) {
        messenger.showSnackBar(SnackBar(content: Text(l10n.savedTo(path))));
      }
    } catch (_) {
      if (!mounted) return;
      messenger.showSnackBar(SnackBar(content: Text(l10n.saveFailed)));
    }
  }
}

class _SourceView extends StatelessWidget {
  const _SourceView({required this.markdown});

  final String markdown;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: SelectableText(
          markdown,
          style: const TextStyle(fontFamily: 'monospace', fontSize: 12.5, height: 1.45),
        ),
      ),
    );
  }
}

class _WarningsBox extends StatelessWidget {
  const _WarningsBox({required this.warnings});

  final List<String> warnings;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);

    return Container(
      margin: const EdgeInsets.fromLTRB(16, 0, 16, 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.tertiaryContainer,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(l10n.warnings, style: theme.textTheme.labelLarge),
          const SizedBox(height: 4),
          ...warnings.take(6).map(
                (warning) => Text('• $warning', style: theme.textTheme.bodySmall),
              ),
        ],
      ),
    );
  }
}

class _PendingCard extends StatelessWidget {
  const _PendingCard({required this.name});

  final String name;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Card(
      child: ListTile(
        leading: const SizedBox(
          width: 24,
          height: 24,
          child: CircularProgressIndicator(strokeWidth: 2.5),
        ),
        title: Text(name, overflow: TextOverflow.ellipsis),
        subtitle: Text(l10n.converting),
      ),
    );
  }
}

class _FailedCard extends StatelessWidget {
  const _FailedCard({required this.name, required this.error, required this.onRemove});

  final String name;
  final String error;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);

    return Card(
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: theme.colorScheme.error),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${l10n.errorTitle}: $name', style: theme.textTheme.titleSmall),
                  const SizedBox(height: 4),
                  Text(error, style: theme.textTheme.bodySmall),
                ],
              ),
            ),
            IconButton(
              icon: const Icon(Icons.close),
              tooltip: l10n.remove,
              onPressed: onRemove,
            ),
          ],
        ),
      ),
    );
  }
}
