import 'dart:io';

import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../core/document_library.dart';

/// The documents this device is holding, listed in the app.
///
/// On iOS and iPadOS these are the same `.md` files the **Files** app shows
/// under *On My iPhone/iPad → MD Converter* — the app writes into its own
/// Documents folder, which `tool/configure_platforms.sh` exposes by setting
/// `UIFileSharingEnabled` and `LSSupportsOpeningDocumentsInPlace`. So they can
/// be opened, copied or moved to iCloud Drive from outside the app too.
class LibrarySection extends StatelessWidget {
  const LibrarySection({
    required this.documents,
    required this.onOpen,
    required this.onDelete,
    super.key,
  });

  final List<DocumentInfo> documents;
  final void Function(DocumentInfo) onOpen;
  final void Function(DocumentInfo) onDelete;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    if (documents.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 8, 4, 8),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(child: Text(l10n.yourDocuments, style: theme.textTheme.titleMedium)),
              Text(
                l10n.documentsOnDevice(documents.length),
                style: theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(4, 0, 4, 10),
          child: Text(
            // Worth saying on iOS, where people do not expect an app's
            // documents to be reachable from outside it.
            Platform.isIOS ? l10n.documentsInFilesApp : l10n.documentsInFinder,
            style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ),
        for (final document in documents)
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: ListTile(
              title: Text(document.name, maxLines: 1, overflow: TextOverflow.ellipsis),
              subtitle: Text(_describe(l10n, document)),
              onTap: () => onOpen(document),
              trailing: IconButton(
                icon: const Icon(Icons.close),
                tooltip: l10n.deleteDocument,
                onPressed: () => _confirmDelete(context, l10n, document),
              ),
            ),
          ),
      ],
    );
  }

  String _describe(AppLocalizations l10n, DocumentInfo document) {
    final elapsed = DateTime.now().difference(document.updated);
    final when = switch (elapsed) {
      Duration(inMinutes: < 1) => l10n.updatedJustNow,
      Duration(inMinutes: final minutes) when minutes < 60 => l10n.updatedMinutes(minutes),
      Duration(inHours: final hours) when hours < 24 => l10n.updatedHours(hours),
      Duration(inDays: final days) when days <= 7 => l10n.updatedDays(days),
      _ => '${document.updated.year}-'
          '${document.updated.month.toString().padLeft(2, '0')}-'
          '${document.updated.day.toString().padLeft(2, '0')}',
    };
    return '${_size(document.bytes)} · $when';
  }

  String _size(int bytes) {
    if (bytes < 1024) return '$bytes B';
    return '${(bytes / 1024).toStringAsFixed(1)} KB';
  }

  Future<void> _confirmDelete(
    BuildContext context,
    AppLocalizations l10n,
    DocumentInfo document,
  ) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        content: Text(l10n.deleteConfirm(document.name)),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.cancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(l10n.deleteDocument),
          ),
        ],
      ),
    );
    if (confirmed == true) onDelete(document);
  }
}
