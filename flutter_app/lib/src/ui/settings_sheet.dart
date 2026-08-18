import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../l10n/app_localizations.dart';
import '../core/conversion.dart';
import '../state/settings_provider.dart';

Future<void> showSettingsSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (context) => const SettingsSheet(),
  );
}

class SettingsSheet extends ConsumerWidget {
  const SettingsSheet({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final settings = ref.watch(settingsProvider);
    final notifier = ref.read(settingsProvider.notifier);
    final options = settings.options;

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.85,
      maxChildSize: 0.95,
      builder: (context, controller) => ListView(
        controller: controller,
        padding: const EdgeInsets.fromLTRB(8, 0, 8, 32),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: Text(l10n.settings, style: Theme.of(context).textTheme.titleLarge),
          ),
          SwitchListTile(
            value: options.frontMatter,
            title: Text(l10n.settingsFrontMatter),
            subtitle: Text(l10n.settingsFrontMatterHint),
            onChanged: (value) => notifier.updateOptions(options.copyWith(frontMatter: value)),
          ),
          SwitchListTile(
            value: options.pageSeparators,
            title: Text(l10n.settingsSeparators),
            subtitle: Text(l10n.settingsSeparatorsHint),
            onChanged: (value) => notifier.updateOptions(options.copyWith(pageSeparators: value)),
          ),
          SwitchListTile(
            value: options.includeNotes,
            title: Text(l10n.settingsNotes),
            subtitle: Text(l10n.settingsNotesHint),
            onChanged: (value) => notifier.updateOptions(options.copyWith(includeNotes: value)),
          ),
          SwitchListTile(
            value: options.detectPdfHeadings,
            title: Text(l10n.settingsPdfHeadings),
            subtitle: Text(l10n.settingsPdfHeadingsHint),
            onChanged: (value) =>
                notifier.updateOptions(options.copyWith(detectPdfHeadings: value)),
          ),
          SwitchListTile(
            value: options.preserveLineBreaks,
            title: Text(l10n.settingsLineBreaks),
            subtitle: Text(l10n.settingsLineBreaksHint),
            onChanged: (value) =>
                notifier.updateOptions(options.copyWith(preserveLineBreaks: value)),
          ),
          const Divider(),
          _DropdownTile<ImageMode>(
            label: l10n.settingsImages,
            value: options.imageMode,
            items: [
              (ImageMode.embed, l10n.settingsImagesEmbed),
              (ImageMode.reference, l10n.settingsImagesReference),
              (ImageMode.skip, l10n.settingsImagesSkip),
            ],
            onChanged: (value) => notifier.updateOptions(options.copyWith(imageMode: value)),
          ),
          _DropdownTile<BulletStyle>(
            label: l10n.settingsBullet,
            value: options.bullet,
            items: const [
              (BulletStyle.hyphen, '-'),
              (BulletStyle.asterisk, '*'),
              (BulletStyle.plus, '+'),
            ],
            onChanged: (value) => notifier.updateOptions(options.copyWith(bullet: value)),
          ),
          _DropdownTile<int>(
            label: l10n.settingsImageLimit,
            value: options.maxEmbeddedImageBytes,
            items: const [
              (131072, '128 KB'),
              (524288, '512 KB'),
              (2097152, '2 MB'),
              (8388608, '8 MB'),
            ],
            onChanged: (value) =>
                notifier.updateOptions(options.copyWith(maxEmbeddedImageBytes: value)),
          ),
          const Divider(),
          _DropdownTile<ThemeMode>(
            label: l10n.settingsTheme,
            value: settings.themeMode,
            items: [
              (ThemeMode.system, l10n.settingsThemeSystem),
              (ThemeMode.light, l10n.settingsThemeLight),
              (ThemeMode.dark, l10n.settingsThemeDark),
            ],
            onChanged: notifier.setThemeMode,
          ),
          _DropdownTile<String>(
            label: l10n.settingsLanguage,
            value: settings.localeCode ?? '',
            items: [
              ('', l10n.settingsLanguageSystem),
              ('en', 'English'),
              ('ar', 'العربية'),
            ],
            onChanged: (value) => notifier.setLocale(value.isEmpty ? null : value),
          ),
        ],
      ),
    );
  }
}

class _DropdownTile<T> extends StatelessWidget {
  const _DropdownTile({
    required this.label,
    required this.value,
    required this.items,
    required this.onChanged,
    super.key,
  });

  final String label;
  final T value;
  final List<(T, String)> items;
  final void Function(T value) onChanged;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      title: Text(label),
      trailing: DropdownButton<T>(
        value: value,
        underline: const SizedBox.shrink(),
        items: items
            .map((item) => DropdownMenuItem<T>(value: item.$1, child: Text(item.$2)))
            .toList(),
        onChanged: (selected) {
          if (selected != null) onChanged(selected);
        },
      ),
    );
  }
}
