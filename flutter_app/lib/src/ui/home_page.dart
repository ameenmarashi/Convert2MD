import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/app_localizations.dart';
import '../core/document_library.dart';
import '../core/text_decode.dart';
import '../platform/opened_files.dart';
import '../state/conversion_provider.dart';
import '../state/settings_provider.dart';
import 'explainers.dart';
import 'file_service.dart';
import 'library_section.dart';
import 'reader_page.dart';
import 'result_card.dart';
import 'settings_sheet.dart';

class HomePage extends ConsumerStatefulWidget {
  const HomePage({super.key});

  @override
  ConsumerState<HomePage> createState() => _HomePageState();
}

class _HomePageState extends ConsumerState<HomePage> {
  static const FileService _files = FileService();
  static const DocumentLibrary _library = DocumentLibrary();

  final OpenedFiles _opened = OpenedFiles();
  StreamSubscription<OpenedFile>? _subscription;
  List<DocumentInfo> _documents = const [];

  @override
  void initState() {
    super.initState();
    // "Open with" from Files, Finder, Drive or a file manager: both the file
    // the app was launched with and any that arrive while it is running.
    _subscription = _opened.stream.listen(_receive);
    unawaited(_refreshLibrary());
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      for (final file in await _opened.initial()) {
        if (mounted) await _receive(file);
      }
    });
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _opened.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
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
              // Header, one card per conversion, then the collapsed explainers.
              itemCount: entries.length + 2,
              itemBuilder: (context, index) {
                if (index == 0) {
                  return Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      PickerCard(
                        onPick: _pick,
                        onNewDocument: _startNewDocument,
                        onOpenMarkdown: _openMarkdown,
                      ),
                      const SizedBox(height: 16),
                      LibrarySection(
                        documents: _documents,
                        onOpen: _openFromLibrary,
                        onDelete: _deleteFromLibrary,
                      ),
                      if (entries.isEmpty && _documents.isEmpty)
                        EmptyState(message: l10n.emptyState),
                    ],
                  );
                }
                if (index == entries.length + 1) {
                  return const Padding(
                    padding: EdgeInsets.only(top: 8),
                    child: LearnMoreSection(),
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

  Future<void> _pick() async {
    final files = await _files.pickFiles();
    if (files.isEmpty) return;

    // Markdown is already the output format — read it rather than convert it.
    final markdown = files.where((file) => isMarkdownFileName(file.name)).toList();
    final rest = files.where((file) => !isMarkdownFileName(file.name)).toList();

    if (markdown.isNotEmpty) await _read(markdown.first);
    if (rest.isEmpty) return;

    final options = ref.read(settingsProvider).options;
    await ref.read(conversionProvider.notifier).addFiles(rest, options);
  }

  /* ---------------------------------------------------------------- library */

  Future<void> _refreshLibrary() async {
    final documents = await _library.list();
    if (mounted) setState(() => _documents = documents);
  }

  Future<void> _startNewDocument() async {
    final created = await _library.create();
    final markdown = await _library.read(created.path) ?? '';
    await _refreshLibrary();
    if (!mounted) return;

    // Straight into the editor: a new document has nothing to read yet.
    await ReaderPage.open(
      context,
      name: created.name,
      markdown: markdown,
      path: created.path,
      startEditing: true,
    );
    await _refreshLibrary();
  }

  Future<void> _openFromLibrary(DocumentInfo document) async {
    final markdown = await _library.read(document.path);
    if (markdown == null) {
      await _refreshLibrary();
      return;
    }
    if (!mounted) return;
    await ReaderPage.open(context, name: document.name, markdown: markdown, path: document.path);
    await _refreshLibrary();
  }

  Future<void> _deleteFromLibrary(DocumentInfo document) async {
    await _library.delete(document.path);
    // A future document can land on this exact name again — the library
    // reuses a freed one, e.g. back to plain "Untitled.md" — so without this
    // a brand new document would open showing this deleted one's draft.
    await ReaderPage.discardDraft(document.name);
    await _refreshLibrary();
    if (mounted) {
      ScaffoldMessenger.of(context)
        ..clearSnackBars()
        ..showSnackBar(SnackBar(content: Text(AppLocalizations.of(context).deleted(document.name))));
    }
  }

  Future<void> _openMarkdown() async {
    final file = await _files.pickMarkdown();
    if (file != null) await _read(file);
  }

  /// A file handed over by the OS: Markdown goes to the reader, anything else
  /// through the converter, which is what the user picked the app for.
  Future<void> _receive(OpenedFile file) async {
    if (isMarkdownFileName(file.name)) {
      await _read(file);
      return;
    }
    final options = ref.read(settingsProvider).options;
    await ref.read(conversionProvider.notifier).addFiles([file], options);
  }

  Future<void> _read(PickedFile file) async {
    final markdown = decodeText(file.bytes).text;
    if (!mounted) return;
    await ReaderPage.open(context, name: file.name, markdown: markdown);
    // It may have been kept while open, so the listing is refreshed either way.
    await _refreshLibrary();
  }
}

class PickerCard extends StatelessWidget {
  const PickerCard({
    required this.onPick,
    required this.onNewDocument,
    required this.onOpenMarkdown,
    super.key,
  });

  final VoidCallback onPick;
  final VoidCallback onNewDocument;
  final VoidCallback onOpenMarkdown;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final scheme = Theme.of(context).colorScheme;

    return Card(
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 32, horizontal: 20),
        child: Column(
          children: [
            Icon(Icons.file_open_outlined, size: 44, color: scheme.primary),
            const SizedBox(height: 12),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: 10,
              runSpacing: 10,
              children: [
                FilledButton.icon(
                  onPressed: onPick,
                  icon: const Icon(Icons.add),
                  label: Text(l10n.chooseFiles),
                ),
                OutlinedButton.icon(
                  onPressed: onNewDocument,
                  icon: const Icon(Icons.note_add_outlined),
                  label: Text(l10n.newDocument),
                ),
                OutlinedButton.icon(
                  onPressed: onOpenMarkdown,
                  icon: const Icon(Icons.menu_book_outlined),
                  label: Text(l10n.openMarkdown),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              l10n.dropHint,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 6),
            Text(
              l10n.openMarkdownHint,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 6),
            Text(
              l10n.privacyShort,
              textAlign: TextAlign.center,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
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
