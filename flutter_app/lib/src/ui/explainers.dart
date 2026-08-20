import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';

/// The explanatory sections: privacy, why Markdown (and AI), and what the app
/// does.
///
/// All three are collapsed behind a summary, so the home screen shows the work
/// — pick a file, read a file — and nothing else until the user asks. Every
/// string is localised, so the English and Arabic copy cannot drift apart.
class LearnMoreSection extends StatelessWidget {
  const LearnMoreSection({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SectionLabel(text: l10n.goodToKnow),
        const PrivacyCard(),
        const SizedBox(height: 8),
        const WhyMarkdownCard(expanded: true),
        const SizedBox(height: 8),
        const AboutSection(),
      ],
    );
  }
}

/// One collapsed panel. Matches the `<details class="panel">` disclosures in
/// the PWA, so both apps hide the same material behind the same gesture.
class Disclosure extends StatelessWidget {
  const Disclosure({required this.title, required this.children, super.key});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Card(
      clipBehavior: Clip.antiAlias,
      child: ExpansionTile(
        shape: const Border(),
        collapsedShape: const Border(),
        title: Text(title, style: theme.textTheme.titleSmall),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 18),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: children,
      ),
    );
  }
}

/// The privacy notice: what the app does not do with the files it opens.
///
/// Every claim here is a property of the build, not a promise — the app ships
/// no analytics, opens no socket of its own, and has no server to send a
/// document to. The one exception is stated rather than glossed over.
class PrivacyCard extends StatelessWidget {
  const PrivacyCard({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    final promises = <(String, String)>[
      (l10n.privacy1Title, l10n.privacy1Body),
      (l10n.privacy2Title, l10n.privacy2Body),
      (l10n.privacy3Title, l10n.privacy3Body),
      (l10n.privacy4Title, l10n.privacy4Body),
      (l10n.privacy5Title, l10n.privacy5Body),
    ];

    return Disclosure(
      title: l10n.privacyTitle,
      children: [
        Text(
          l10n.privacyLede,
          style: theme.textTheme.bodyMedium
              ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 16),
        for (final promise in promises)
          CheckedPoint(title: promise.$1, body: promise.$2),
        const Divider(height: 24),
        Text(
          l10n.privacyException,
          style: theme.textTheme.bodySmall
              ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 10),
        Text(
          l10n.privacyVerify,
          style: theme.textTheme.bodySmall
              ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        ),
      ],
    );
  }
}

/// One privacy promise: the claim, then how it is achieved.
class CheckedPoint extends StatelessWidget {
  const CheckedPoint({required this.title, required this.body, super.key});

  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsetsDirectional.only(end: 10, top: 2),
            child: Icon(Icons.check, size: 16, color: scheme.primary),
          ),
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

class WhyMarkdownCard extends StatelessWidget {
  const WhyMarkdownCard({this.expanded = false, super.key});

  /// `true` renders the reasons and the AI section; `false` the summary only.
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);

    if (!expanded) {
      return Card(
        color: theme.colorScheme.surfaceContainerHighest,
        child: ExpansionTile(
          shape: const Border(),
          collapsedShape: const Border(),
          title: Text(l10n.whyMarkdownTitle, style: theme.textTheme.titleSmall),
          childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(l10n.whyMarkdownShort, style: theme.textTheme.bodySmall),
          ],
        ),
      );
    }

    final reasons = <(String, String)>[
      (l10n.whyReason1Title, l10n.whyReason1Body),
      (l10n.whyReason2Title, l10n.whyReason2Body),
      (l10n.whyReason3Title, l10n.whyReason3Body),
      (l10n.whyReason4Title, l10n.whyReason4Body),
    ];
    final aiReasons = <(String, String)>[
      (l10n.whyAi1Title, l10n.whyAi1Body),
      (l10n.whyAi2Title, l10n.whyAi2Body),
      (l10n.whyAi3Title, l10n.whyAi3Body),
      (l10n.whyAi4Title, l10n.whyAi4Body),
      (l10n.whyAi5Title, l10n.whyAi5Body),
    ];

    return Disclosure(
      title: l10n.whyMarkdownTitle,
      children: [
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
        SectionLabel(text: l10n.whyAiTitle),
        Text(
          l10n.whyAiLede,
          style: theme.textTheme.bodyMedium
              ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 14),
        for (var i = 0; i < aiReasons.length; i++)
          NumberedPoint(
            index: i + 1,
            title: aiReasons[i].$1,
            body: aiReasons[i].$2,
            filled: false,
          ),
        const Divider(height: 24),
        Text(
          l10n.whyMarkdownClose,
          style: theme.textTheme.bodySmall
              ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        ),
      ],
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

    return Disclosure(
      title: l10n.aboutTitle2,
      children: [
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
        SectionLabel(text: l10n.aboutFormatsTitle),
        Text(
          l10n.aboutFormats,
          style: theme.textTheme.bodySmall
              ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
        ),
        const SizedBox(height: 20),
        FactTile(title: l10n.aboutPrivateTitle, body: l10n.aboutPrivateBody),
        const SizedBox(height: 12),
        FactTile(title: l10n.aboutOfflineTitle, body: l10n.aboutOfflineBody),
      ],
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
