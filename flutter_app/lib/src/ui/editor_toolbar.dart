import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../core/markdown_editing.dart';

/// The formatting toolbar.
///
/// Every button is labelled with what it makes, not with the marks it inserts,
/// and carries a tooltip saying it in plain words — so nothing has to be known
/// about Markdown before starting. Mirrors the toolbar in
/// `web/public/index.html`.
class EditorToolbar extends StatelessWidget {
  const EditorToolbar({required this.onAction, super.key});

  final void Function(EditorAction) onAction;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    final groups = <List<_Button>>[
      [
        _Button(EditorAction.h1, 'H1', l10n.tipH1),
        _Button(EditorAction.h2, 'H2', l10n.tipH2),
        _Button(EditorAction.h3, 'H3', l10n.tipH3),
      ],
      [
        _Button(EditorAction.bold, 'B', l10n.tipBold, weight: FontWeight.w800),
        _Button(EditorAction.italic, 'I', l10n.tipItalic, italic: true),
        _Button(EditorAction.strike, 'S', l10n.tipStrike, struck: true),
        _Button(EditorAction.code, '</>', l10n.tipCode),
      ],
      [
        _Button(EditorAction.bullet, '• List', l10n.tipBullet),
        _Button(EditorAction.number, '1. List', l10n.tipNumber),
        _Button(EditorAction.task, '☐ Tasks', l10n.tipTask),
      ],
      [
        _Button(EditorAction.link, '🔗 Link', l10n.tipLink),
        _Button(EditorAction.quote, '” Quote', l10n.tipQuote),
        _Button(EditorAction.table, '▦ Table', l10n.tipTable),
        _Button(EditorAction.rule, '— Divider', l10n.tipRule),
      ],
    ];

    return Material(
      color: theme.colorScheme.surfaceContainerLowest,
      shape: Border(bottom: BorderSide(color: theme.colorScheme.outlineVariant)),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: Row(
          children: [
            for (var group = 0; group < groups.length; group++) ...[
              if (group > 0)
                Container(
                  width: 1,
                  height: 22,
                  margin: const EdgeInsets.symmetric(horizontal: 8),
                  color: theme.colorScheme.outlineVariant,
                ),
              for (final button in groups[group])
                Tooltip(
                  message: button.tip,
                  child: TextButton(
                    onPressed: () => onAction(button.action),
                    style: TextButton.styleFrom(
                      minimumSize: const Size(40, 40),
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      foregroundColor: theme.colorScheme.onSurface,
                      textStyle: theme.textTheme.labelLarge?.copyWith(
                        fontWeight: button.weight,
                        fontStyle: button.italic ? FontStyle.italic : null,
                        decoration: button.struck ? TextDecoration.lineThrough : null,
                      ),
                    ),
                    child: Text(button.label),
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }
}

class _Button {
  const _Button(
    this.action,
    this.label,
    this.tip, {
    this.weight,
    this.italic = false,
    this.struck = false,
  });

  final EditorAction action;
  final String label;
  final String tip;
  final FontWeight? weight;
  final bool italic;
  final bool struck;
}

/// The nine lines of Markdown a beginner actually needs, collapsed by default.
class CheatSheet extends StatelessWidget {
  const CheatSheet({super.key});

  static const List<(String, String)> _rows = [
    ('# Title', 'A big heading'),
    ('## Section', 'A smaller heading'),
    ('**bold**', 'bold'),
    ('*italic*', 'italic'),
    ('- item', 'A bulleted list'),
    ('1. item', 'A numbered list'),
    ('- [ ] task', 'A checklist you can tick'),
    ('[text](address)', 'A link'),
    ('> words', 'A quote, set apart'),
  ];

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    return ExpansionTile(
      shape: const Border(),
      collapsedShape: const Border(),
      title: Text(l10n.editorCheatsheetTitle, style: theme.textTheme.titleSmall),
      childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
      expandedCrossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          l10n.editorCheatsheetLede,
          style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 12),
        Table(
          border: TableBorder.all(color: theme.colorScheme.outlineVariant),
          columnWidths: const {0: FlexColumnWidth(1.1), 1: FlexColumnWidth(1)},
          children: [
            TableRow(
              decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest),
              children: [
                _cell(context, l10n.editorCheatsheetTyped, header: true),
                _cell(context, l10n.editorCheatsheetResult, header: true),
              ],
            ),
            for (final row in _rows)
              TableRow(children: [_cell(context, row.$1), _cell(context, row.$2)]),
          ],
        ),
        const SizedBox(height: 12),
        Text(
          l10n.editorCheatsheetHelp,
          style: theme.textTheme.bodySmall?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        ),
      ],
    );
  }

  Widget _cell(BuildContext context, String text, {bool header = false}) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      child: Text(
        text,
        style: header
            ? theme.textTheme.labelSmall?.copyWith(color: theme.colorScheme.onSurfaceVariant)
            : theme.textTheme.bodySmall,
      ),
    );
  }
}
