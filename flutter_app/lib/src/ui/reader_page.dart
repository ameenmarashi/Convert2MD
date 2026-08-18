import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../../l10n/app_localizations.dart';
import 'file_service.dart';

/// Reading view for a Markdown file.
///
/// A `.md` file is already the finished document, so there is nothing to
/// convert — it only needs to be readable. Mirrors `web/src/ui/reader.ts`:
/// one comfortable measure, a contents list built from the headings, and a
/// text size that persists for the session.
class ReaderPage extends StatefulWidget {
  const ReaderPage({required this.name, required this.markdown, super.key});

  final String name;
  final String markdown;

  static Future<void> open(BuildContext context, {required String name, required String markdown}) {
    return Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ReaderPage(name: name, markdown: markdown),
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

  final ScrollController _scroll = ScrollController();
  late final List<_Heading> _headings = _outlineOf(widget.markdown);
  bool _showSource = false;

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final scale = _scales[_scaleIndex];

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(widget.name, style: theme.textTheme.titleSmall, overflow: TextOverflow.ellipsis),
            Text(_describe(l10n), style: theme.textTheme.labelSmall),
          ],
        ),
        actions: [
          if (_headings.length > 1)
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
          PopupMenuButton<_ReaderAction>(
            onSelected: _run,
            itemBuilder: (context) => [
              PopupMenuItem(
                value: _ReaderAction.toggleSource,
                child: Text(_showSource ? l10n.readerFormatted : l10n.readerSource),
              ),
              PopupMenuItem(value: _ReaderAction.copy, child: Text(l10n.copy)),
              PopupMenuItem(value: _ReaderAction.save, child: Text(l10n.save)),
            ],
          ),
        ],
      ),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            // Roughly 74 characters at the base size — the measure prose reads
            // best at, and the same one the web reader uses.
            constraints: const BoxConstraints(maxWidth: 720),
            child: _showSource
                ? _SourceView(markdown: widget.markdown, scale: scale)
                : Markdown(
                    controller: _scroll,
                    data: widget.markdown,
                    selectable: true,
                    padding: const EdgeInsets.fromLTRB(20, 16, 20, 64),
                    styleSheet: _styleSheet(theme, scale),
                    onTapLink: (_, href, __) => _openLink(href),
                  ),
          ),
        ),
      ),
    );
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
    final words = widget.markdown
        .replaceAll(RegExp(r'```[\s\S]*?```'), ' ')
        .replaceAll(RegExp(r'[#*_>`|-]'), ' ')
        .split(RegExp(r'\s+'))
        .where((word) => word.isNotEmpty)
        .length;
    // 200 wpm is the usual figure for reading prose on a screen.
    final minutes = (words / 200).round();
    return l10n.readerMeta(words, minutes < 1 ? 1 : minutes);
  }

  void _run(_ReaderAction action) {
    switch (action) {
      case _ReaderAction.toggleSource:
        setState(() => _showSource = !_showSource);
      case _ReaderAction.copy:
        Clipboard.setData(ClipboardData(text: widget.markdown));
        _tell(AppLocalizations.of(context).copied);
      case _ReaderAction.save:
        unawaited(_save());
    }
  }

  Future<void> _save() async {
    final l10n = AppLocalizations.of(context);
    final destination = await _files.save(widget.name, widget.markdown);
    if (destination != null && mounted) _tell(l10n.savedTo(destination));
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
    final fraction = heading.offset / widget.markdown.length;
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

enum _ReaderAction { toggleSource, copy, save }

class _SourceView extends StatelessWidget {
  const _SourceView({required this.markdown, required this.scale});

  final String markdown;
  final double scale;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(20, 16, 20, 64),
      child: SelectableText(
        markdown,
        style: TextStyle(fontSize: 13 * scale, height: 1.5),
      ),
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
