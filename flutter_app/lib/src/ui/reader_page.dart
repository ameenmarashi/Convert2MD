import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../l10n/app_localizations.dart';
import '../core/document_library.dart';
import '../core/markdown_editing.dart';
import 'editor_toolbar.dart';
import 'file_service.dart';

/// Reading view for a Markdown file.
///
/// A `.md` file is already the finished document, so there is nothing to
/// convert — it only needs to be readable. Mirrors `web/src/ui/reader.ts`:
/// one comfortable measure, a contents list built from the headings, and a
/// text size that persists for the session.
class ReaderPage extends StatefulWidget {
  const ReaderPage({
    required this.name,
    required this.markdown,
    this.path,
    this.startEditing = false,
    super.key,
  });

  final String name;
  final String markdown;

  /// Set when the document is a file in the app's library, and so can be saved
  /// back to where it came from and renamed in place.
  final String? path;

  final bool startEditing;

  static const String _draftPrefix = 'md-converter.draft.';

  /// Frees a draft slot outright — call when the document it belonged to is
  /// deleted, so a later document that lands on the same default name (the
  /// library reuses a freed name, e.g. "Untitled.md") does not resurrect it.
  static Future<void> discardDraft(String name) async {
    final store = await SharedPreferences.getInstance();
    await store.remove('$_draftPrefix$name');
  }

  static Future<void> open(
    BuildContext context, {
    required String name,
    required String markdown,
    String? path,
    bool startEditing = false,
  }) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ReaderPage(
          name: name,
          markdown: markdown,
          path: path,
          startEditing: startEditing,
        ),
      ),
    );
  }

  @override
  State<ReaderPage> createState() => _ReaderPageState();
}

class _ReaderPageState extends State<ReaderPage> {
  static const List<double> _scales = [0.9, 1, 1.15, 1.3, 1.5];
  static const FileService _files = FileService();

  // Kept across pushes so the reader reopens at the size the reader chose.
  static int _scaleIndex = 1;

  static const Duration _previewDelay = Duration(milliseconds: 160);
  static const DocumentLibrary _library = DocumentLibrary();

  final ScrollController _scroll = ScrollController();
  late final TextEditingController _controller = TextEditingController(text: widget.markdown);
  late final TextEditingController _nameController = TextEditingController(text: widget.name);
  late final FocusNode _inputFocus = FocusNode();

  late List<_Heading> _headings = _outlineOf(widget.markdown);
  late String _baseline = widget.markdown;
  late String _rendered = widget.markdown;

  late String _name = widget.name;
  late String? _path = widget.path;
  late bool _editing = widget.startEditing;
  Timer? _previewTimer;

  /// True when the document is a file in the library, so Save writes back to
  /// it and the title can be renamed in place.
  bool get _inLibrary => _path != null;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onTextChanged);
    unawaited(_restoreDraft());
  }

  @override
  void dispose() {
    _previewTimer?.cancel();
    _controller.removeListener(_onTextChanged);
    _controller.dispose();
    _nameController.dispose();
    _inputFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  String get _markdown => _controller.text;

  bool get _dirty => _markdown != _baseline;

  /// Typing is kept on the device as it happens, so leaving the screen by
  /// accident does not lose an hour of work. It is dropped once the file is
  /// saved, and it never leaves the device.
  Future<void> _restoreDraft() async {
    final store = await SharedPreferences.getInstance();
    final draft = store.getString('${ReaderPage._draftPrefix}$_name');
    if (draft == null || draft == widget.markdown || !mounted) return;

    _controller.text = draft;
    setState(() {
      _rendered = draft;
      _headings = _outlineOf(draft);
    });
    _tell(AppLocalizations.of(context).editorDraftRestored);
  }

  Future<void> _saveDraft() async {
    final store = await SharedPreferences.getInstance();
    await store.setString('${ReaderPage._draftPrefix}$_name', _markdown);
  }

  Future<void> _clearDraft() async {
    await ReaderPage.discardDraft(_name);
  }

  void _onTextChanged() {
    // Re-parsing the whole document on every keystroke would stutter on a long
    // file, so the redraw waits for a pause in typing.
    _previewTimer?.cancel();
    _previewTimer = Timer(_previewDelay, () {
      if (!mounted) return;
      setState(() {
        _rendered = _markdown;
        _headings = _outlineOf(_markdown);
      });
    });
    unawaited(_saveDraft());
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final scale = _scales[_scaleIndex];

    return PopScope(
      canPop: !_dirty,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_confirmLeave());
      },
      child: Scaffold(
        appBar: AppBar(
          title: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              // A library document is renamed by typing over its title — on
              // iOS there is no folder to go and rename it in.
              if (_inLibrary)
                TextField(
                  controller: _nameController,
                  style: theme.textTheme.titleSmall,
                  decoration: InputDecoration(
                    isDense: true,
                    border: InputBorder.none,
                    contentPadding: EdgeInsets.zero,
                    hintText: l10n.documentName,
                  ),
                  onSubmitted: (_) => unawaited(_applyRename()),
                  onTapOutside: (_) => unawaited(_applyRename()),
                )
              else
                Text(_name, style: theme.textTheme.titleSmall, overflow: TextOverflow.ellipsis),
              Text(_describe(l10n), style: theme.textTheme.labelSmall),
            ],
          ),
          actions: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: SegmentedButton<bool>(
                segments: [
                  ButtonSegment(value: false, label: Text(l10n.read)),
                  ButtonSegment(value: true, label: Text(l10n.edit)),
                ],
                selected: {_editing},
                showSelectedIcon: false,
                style: const ButtonStyle(visualDensity: VisualDensity.compact),
                onSelectionChanged: (selection) => setState(() => _editing = selection.first),
              ),
            ),
            if (!_editing && _headings.length > 1)
              IconButton(
                icon: const Icon(Icons.list_alt_outlined),
                tooltip: l10n.readerContents,
                onPressed: _showContents,
              ),
            IconButton(
              icon: const Icon(Icons.text_decrease),
              tooltip: l10n.readerSmaller,
              onPressed: _scaleIndex == 0 ? null : () => setState(() => _scaleIndex--),
            ),
            IconButton(
              icon: const Icon(Icons.text_increase),
              tooltip: l10n.readerLarger,
              onPressed: _scaleIndex == _scales.length - 1 ? null : () => setState(() => _scaleIndex++),
            ),
            if (_inLibrary)
              IconButton(
                icon: const Icon(Icons.save_outlined),
                tooltip: l10n.save,
                onPressed: _dirty ? () => unawaited(_saveToLibrary()) : null,
              ),
            PopupMenuButton<_ReaderAction>(
              onSelected: _run,
              itemBuilder: (context) => [
                if (!_inLibrary)
                  PopupMenuItem(value: _ReaderAction.keep, child: Text(l10n.keepInApp)),
                PopupMenuItem(value: _ReaderAction.copy, child: Text(l10n.copy)),
                PopupMenuItem(value: _ReaderAction.export, child: Text(l10n.exportCopy)),
              ],
            ),
          ],
        ),
        body: SafeArea(
          child: _editing ? _buildEditor(context, scale) : _buildReader(theme, scale),
        ),
      ),
    );
  }

  Widget _buildReader(ThemeData theme, double scale) {
    return Center(
      child: ConstrainedBox(
        // Roughly 74 characters at the base size — the measure prose reads best
        // at, and the same one the web reader uses.
        constraints: const BoxConstraints(maxWidth: 720),
        child: Markdown(
          controller: _scroll,
          data: _rendered,
          selectable: true,
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 64),
          styleSheet: _styleSheet(theme, scale),
          onTapLink: (_, href, __) => _openLink(href),
        ),
      ),
    );
  }

  /// Text and preview together: watching one become the other is what teaches
  /// the marks. Side by side where there is room, stacked where there is not.
  Widget _buildEditor(BuildContext context, double scale) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final wide = MediaQuery.sizeOf(context).width >= 900;

    final input = _EditorPane(
      label: l10n.editorYourText,
      child: Focus(
        onKeyEvent: _onKeyEvent,
        child: TextField(
          controller: _controller,
          focusNode: _inputFocus,
          maxLines: null,
          expands: true,
          textAlignVertical: TextAlignVertical.top,
          keyboardType: TextInputType.multiline,
          decoration: InputDecoration(
            hintText: l10n.editorPlaceholder,
            border: const OutlineInputBorder(),
            filled: true,
            fillColor: theme.colorScheme.surfaceContainerLowest,
          ),
          style: TextStyle(fontSize: 14 * scale, height: 1.6),
        ),
      ),
    );

    final preview = _EditorPane(
      label: l10n.editorPreviewLabel,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Markdown(
          data: _rendered,
          padding: const EdgeInsets.all(14),
          styleSheet: _styleSheet(theme, scale),
          onTapLink: (_, href, __) => _openLink(href),
        ),
      ),
    );

    return Column(
      children: [
        EditorToolbar(onAction: _format),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
            child: wide
                ? Row(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(child: input),
                      const SizedBox(width: 12),
                      Expanded(child: preview),
                    ],
                  )
                : Column(
                    children: [
                      // The writing surface gets the larger share; the preview
                      // is there to be glanced at, not typed into.
                      Expanded(flex: 3, child: input),
                      const SizedBox(height: 10),
                      Expanded(flex: 2, child: preview),
                    ],
                  ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: Align(
            alignment: AlignmentDirectional.centerStart,
            child: Text(
              _dirty ? l10n.editorUnsaved : l10n.editorSaved,
              style: theme.textTheme.labelSmall?.copyWith(
                color: _dirty ? theme.colorScheme.tertiary : theme.colorScheme.onSurfaceVariant,
                fontWeight: _dirty ? FontWeight.w700 : null,
              ),
            ),
          ),
        ),
        const CheatSheet(),
      ],
    );
  }

  /* ------------------------------------------------------------- editing */

  void _format(EditorAction action) {
    final selection = _controller.selection;
    final start = selection.start < 0 ? _markdown.length : selection.start;
    final end = selection.end < 0 ? start : selection.end;

    _applyEdit(applyAction(action, _markdown, start, end));
    _inputFocus.requestFocus();
  }

  void _applyEdit(EditResult result) {
    _controller.value = TextEditingValue(
      text: result.text,
      selection: TextSelection(baseOffset: result.start, extentOffset: result.end),
    );
  }

  /// Enter continues a list and Tab nests one — the two things that make a
  /// list feel like a list rather than like typing dashes. Outside a list both
  /// keys do what they always do, so Tab can still move focus out of the field.
  KeyEventResult _onKeyEvent(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent) return KeyEventResult.ignored;

    final selection = _controller.selection;
    if (!selection.isValid) return KeyEventResult.ignored;

    final shift = HardwareKeyboard.instance.isShiftPressed;

    if (event.logicalKey == LogicalKeyboardKey.enter && !shift && selection.isCollapsed) {
      final result = continueList(_markdown, selection.baseOffset);
      if (result == null) return KeyEventResult.ignored;
      _applyEdit(result);
      return KeyEventResult.handled;
    }

    if (event.logicalKey == LogicalKeyboardKey.tab) {
      final result = indentListItems(_markdown, selection.start, selection.end, outdent: shift);
      if (result == null) return KeyEventResult.ignored;
      _applyEdit(result);
      return KeyEventResult.handled;
    }

    return KeyEventResult.ignored;
  }

  Future<void> _confirmLeave() async {
    final l10n = AppLocalizations.of(context);
    final leave = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(l10n.editorDiscardTitle),
        content: Text(l10n.editorDiscardBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: Text(l10n.editorDiscardStay),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: Text(l10n.editorDiscardLeave),
          ),
        ],
      ),
    );
    if (leave == true && mounted) Navigator.of(context).pop();
  }

  MarkdownStyleSheet _styleSheet(ThemeData theme, double scale) {
    final base = MarkdownStyleSheet.fromTheme(theme);
    final body = theme.textTheme.bodyLarge?.copyWith(
      fontSize: (theme.textTheme.bodyLarge?.fontSize ?? 16) * scale,
      height: 1.7,
    );
    return base.copyWith(
      p: body,
      listBullet: body,
      h1: theme.textTheme.headlineMedium?.copyWith(fontSize: 30 * scale, fontWeight: FontWeight.w700),
      h2: theme.textTheme.headlineSmall?.copyWith(fontSize: 24 * scale, fontWeight: FontWeight.w700),
      h3: theme.textTheme.titleLarge?.copyWith(fontSize: 20 * scale, fontWeight: FontWeight.w600),
      blockquoteDecoration: BoxDecoration(
        border: Border(left: BorderSide(color: theme.colorScheme.outlineVariant, width: 3)),
      ),
      codeblockDecoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
      ),
      tableBorder: TableBorder.all(color: theme.colorScheme.outlineVariant),
    );
  }

  String _describe(AppLocalizations l10n) {
    final words = _rendered
        .replaceAll(RegExp(r'```[\s\S]*?```'), ' ')
        .replaceAll(RegExp(r'[#*_>`|-]'), ' ')
        .split(RegExp(r'\s+'))
        .where((word) => word.isNotEmpty)
        .length;
    // 200 wpm is the usual figure for reading prose on a screen.
    final minutes = (words / 200).round();
    final meta = l10n.readerMeta(words, minutes < 1 ? 1 : minutes);
    return _dirty ? '$meta · ${l10n.editorUnsavedShort}' : meta;
  }

  void _run(_ReaderAction action) {
    switch (action) {
      case _ReaderAction.keep:
        unawaited(_keepInLibrary());
      case _ReaderAction.copy:
        Clipboard.setData(ClipboardData(text: _markdown));
        _tell(AppLocalizations.of(context).copied);
      case _ReaderAction.export:
        unawaited(_save());
    }
  }

  /// Writes the document back to its file in the library.
  Future<void> _saveToLibrary() async {
    final path = _path;
    if (path == null) return;

    final l10n = AppLocalizations.of(context);
    await _library.saveAt(path, _markdown);
    await _clearDraft();
    if (!mounted) return;
    setState(() => _baseline = _markdown);
    _tell(l10n.savedToDevice);
  }

  /// Adds a document that came from a file to the library, so it has somewhere
  /// to live between sessions.
  Future<void> _keepInLibrary() async {
    final l10n = AppLocalizations.of(context);
    final kept = await _library.import(_name, _markdown);
    if (!mounted) return;

    setState(() {
      _path = kept.path;
      _name = kept.name;
      _baseline = _markdown;
    });
    _nameController.text = kept.name;
    _tell(l10n.keptAs(kept.name));
  }

  Future<void> _applyRename() async {
    final path = _path;
    final wanted = _nameController.text.trim();
    if (path == null || wanted.isEmpty || wanted == _name) {
      _nameController.text = _name;
      return;
    }

    final l10n = AppLocalizations.of(context);
    final renamed = await _library.rename(path, wanted);
    if (renamed == null || !mounted) {
      _nameController.text = _name;
      return;
    }

    // The draft lives under the old name; without moving it, it would sit
    // there as an orphan until some future, unrelated document happened to
    // land on that exact name and inherited it.
    final oldName = _name;
    setState(() {
      _path = renamed.path;
      _name = renamed.name;
    });
    if (_dirty) await _saveDraft();
    await ReaderPage.discardDraft(oldName);
    _nameController.text = renamed.name;
    if (renamed.name != DocumentLibrary.normaliseName(wanted)) {
      _tell(l10n.renameCollision(renamed.name));
    }
  }

  Future<void> _save() async {
    final l10n = AppLocalizations.of(context);
    final destination = await _files.save(_name, _markdown);
    if (destination == null || !mounted) return;

    // Saving is how a document leaves the app, so it is what "saved" means
    // here — the draft it was keeping is no longer needed.
    setState(() => _baseline = _markdown);
    await _clearDraft();
    if (mounted) _tell(l10n.savedTo(destination));
  }

  void _showContents() {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheetContext) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final heading in _headings)
              ListTile(
                dense: heading.level > 1,
                contentPadding: EdgeInsets.only(left: 16.0 + (heading.level - 1) * 16, right: 16),
                title: Text(heading.text, maxLines: 2, overflow: TextOverflow.ellipsis),
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  _scrollTo(heading);
                },
              ),
          ],
        ),
      ),
    );
  }

  /// flutter_markdown lays every block out in one list without keys, so the
  /// only handle on a heading is where its text sits in the source. Scrolling
  /// by that fraction lands on the right screen without a second layout pass.
  void _scrollTo(_Heading heading) {
    if (!_scroll.hasClients) return;
    final fraction = heading.offset / _rendered.length;
    final target = _scroll.position.maxScrollExtent * fraction;
    _scroll.animateTo(
      target.clamp(0, _scroll.position.maxScrollExtent),
      duration: const Duration(milliseconds: 320),
      curve: Curves.easeOutCubic,
    );
  }

  void _tell(String message) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _openLink(String? href) async {
    // No url_launcher dependency: an external link is offered as text the
    // reader can copy, which keeps the app free of network plumbing.
    if (href == null || href.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: href));
    if (mounted) _tell(AppLocalizations.of(context).linkCopied(href));
  }
}

enum _ReaderAction { keep, copy, export }

/// One labelled half of the editor — the text, or what it will look like.
class _EditorPane extends StatelessWidget {
  const _EditorPane({required this.label, required this.child});

  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 6, left: 2),
          child: Align(
            alignment: AlignmentDirectional.centerStart,
            child: Text(
              label.toUpperCase(),
              style: theme.textTheme.labelSmall?.copyWith(
                letterSpacing: 1.2,
                fontWeight: FontWeight.w700,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ),
        Expanded(child: child),
      ],
    );
  }
}

class _Heading {
  const _Heading({required this.level, required this.text, required this.offset});

  final int level;
  final String text;
  final int offset;
}

/// Headings in source order, skipping anything inside a fenced code block.
List<_Heading> _outlineOf(String markdown) {
  final headings = <_Heading>[];
  var offset = 0;
  var inFence = false;

  for (final line in markdown.split('\n')) {
    if (RegExp(r'^\s*(```|~~~)').hasMatch(line)) inFence = !inFence;
    if (!inFence) {
      final match = RegExp(r'^(#{1,3})\s+(.+?)\s*#*\s*$').firstMatch(line);
      if (match != null) {
        headings.add(_Heading(
          level: match.group(1)!.length,
          text: match.group(2)!.replaceAll(RegExp(r'[*_`]'), ''),
          offset: offset,
        ));
      }
    }
    offset += line.length + 1;
  }
  return headings;
}
