import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';

/// "Why Markdown, in a nutshell" and "What this app does".
///
/// The short form sits in the settings sheet; the full form sits at the bottom
/// of the home page. Both read from the same localised strings, so the English
/// and Arabic copy can never drift apart.
class WhyMarkdownCard extends StatelessWidget {
  const WhyMarkdownCard({this.expanded = false, super.key});

  /// `true` renders the five numbered reasons; `false` renders the summary only.
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    final reasons = <(String, String)>[
      (l10n.whyReason1Title, l10n.whyReason1Body),
      (l10n.whyReason2Title, l10n.whyReason2Body),
      (l10n.whyReason3Title, l10n.whyReason3Body),
      (l10n.whyReason4Title, l10n.whyReason4Body),
      (l10n.whyReason5Title, l10n.whyReason5Body),
    ];

    if (!expanded) {
      return Card(
        color: theme.colorScheme.surfaceContainerHighest,
        child: ExpansionTile(
          shape: const Border(),
          collapsedShape: const Border(),
          title: Text(l10n.whyMarkdownTitle, style: theme.textTheme.titleSmall),
          childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            Align(
              alignment: AlignmentDirectional.centerStart,
              child: Text(l10n.whyMarkdownShort, style: theme.textTheme.bodySmall),
            ),
          ],
        ),
      );
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.whyMarkdownTitle, style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              l10n.whyMarkdownLede,
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            for (var i = 0; i < reasons.length; i++)
              NumberedPoint(
                index: i + 1,
                title: reasons[i].$1,
                body: reasons[i].$2,
                filled: false,
              ),
            const Divider(height: 24),
            Text(
              l10n.whyMarkdownClose,
              style: theme.textTheme.bodySmall
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }
}

class AboutSection extends StatelessWidget {
  const AboutSection({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    final steps = <(String, String)>[
      (l10n.aboutStep1Title, l10n.aboutStep1Body),
      (l10n.aboutStep2Title, l10n.aboutStep2Body),
      (l10n.aboutStep3Title, l10n.aboutStep3Body),
    ];

    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.aboutTitle2, style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(
              l10n.aboutLede,
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            for (var i = 0; i < steps.length; i++)
              NumberedPoint(
                index: i + 1,
                title: steps[i].$1,
                body: steps[i].$2,
                filled: true,
              ),
            const SizedBox(height: 8),
            SectionLabel(text: l10n.aboutFormatsTitle),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final format in l10n.aboutFormats.split(' · '))
                  Chip(
                    label: Text(format, style: theme.textTheme.labelSmall),
                    visualDensity: VisualDensity.compact,
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
              ],
            ),
            const SizedBox(height: 20),
            FactTile(title: l10n.aboutPrivateTitle, body: l10n.aboutPrivateBody),
            const SizedBox(height: 12),
            FactTile(title: l10n.aboutOfflineTitle, body: l10n.aboutOfflineBody),
          ],
        ),
      ),
    );
  }
}

class NumberedPoint extends StatelessWidget {
  const NumberedPoint({
    required this.index,
    required this.title,
    required this.body,
    required this.filled,
    super.key,
  });

  final int index;
  final String title;
  final String body;

  /// Filled badges mark the conversion steps; outlined ones mark the reasons.
  final bool filled;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: filled ? scheme.primary : scheme.primaryContainer,
              borderRadius: BorderRadius.circular(filled ? 8 : 13),
            ),
            child: Text(
              '$index',
              style: theme.textTheme.labelMedium?.copyWith(
                color: filled ? scheme.onPrimary : scheme.onPrimaryContainer,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: theme.textTheme.titleSmall),
                const SizedBox(height: 2),
                Text(
                  body,
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class FactTile extends StatelessWidget {
  const FactTile({required this.title, required this.body, super.key});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        border: Border.all(color: theme.colorScheme.outlineVariant),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.titleSmall),
          const SizedBox(height: 4),
          Text(
            body,
            style: theme.textTheme.bodySmall
                ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

class SectionLabel extends StatelessWidget {
  const SectionLabel({required this.text, super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 8, bottom: 10),
      child: Text(
        text.toUpperCase(),
        style: theme.textTheme.labelSmall?.copyWith(
          letterSpacing: 1.2,
          fontWeight: FontWeight.w700,
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
    );
  }
}
