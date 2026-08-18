import 'package:flutter_test/flutter_test.dart';
import 'package:md_converter/src/core/conversion.dart';
import 'package:md_converter/src/core/converter_registry.dart';
import 'package:md_converter/src/core/markdown.dart';
import 'package:md_converter/src/converters/csv_converter.dart';

import 'fixtures.dart';

/// Mirrors `web/test/converters.test.mjs`: the two engines are expected to
/// produce the same Markdown for the same input.
void main() {
  const options = ConvertOptions();

  ConversionResult convert(String name, Object data, [ConvertOptions? overrides]) {
    return convertFile(sourceFile(name, data), overrides ?? options);
  }

  group('markdown helpers', () {
    test('table renderer pads columns and escapes pipes', () {
      final table = renderTable([
        ['Name', 'Value'],
        ['a|b', '2'],
      ]);
      expect(table, contains('| Name | Value |'));
      expect(table, contains(r'a\|b'));
    });

    test('normalizeMarkdown collapses blank runs and keeps hard breaks', () {
      expect(normalizeMarkdown('a\n\n\n\nb  \nc   '), 'a\n\nb  \nc\n');
    });

    test('word count ignores markers, code blocks and image data', () {
      expect(countWords('# Title\n\nTwo words here.'), 4);
      expect(countWords('```\nnot counted at all\n```\n\nreal text'), 2);
    });
  });

  group('docx', () {
    test('converts headings, emphasis, lists, tables, links and footnotes', () {
      final result = convert('review.docx', makeDocx());

      expect(result.format, 'Word (.docx)');
      expect(result.markdown, contains('title: Annual Review 2024'));
      expect(result.markdown, contains('\n# Annual Review\n'));
      expect(result.markdown, contains('\n## Summary\n'));
      expect(result.markdown, contains('Revenue grew by **18%** across *all regions*.'));
      expect(result.markdown, contains('[Read the full report](https://example.com/report)'));
      expect(result.markdown, contains('\n- First item\n'));
      expect(result.markdown, contains('\n1. Step one\n'));
      expect(result.markdown, contains('\n2. Step two\n'));
      expect(result.markdown, contains('| Region | Growth |'));
      expect(result.markdown, contains('![Growth chart](data:image/png;base64,'));
      expect(result.markdown, contains('[^fn1]: Figures are unaudited.'));
      expect(result.imageCount, 1);
    });

    test('image mode "skip" leaves pictures out', () {
      final result = convert('review.docx', makeDocx(), options.copyWith(imageMode: ImageMode.skip));
      expect(result.imageCount, 0);
      expect(result.markdown.contains('data:image/png'), isFalse);
    });

    test('Google Docs export converts headings, lists, tables and links', () {
      final result = convert('Team Handbook.docx', makeGoogleDocsDocx());

      expect(result.markdown, contains('\n# Team Handbook\n'));
      expect(result.markdown, contains('\n# Working hours\n'));
      expect(result.markdown, contains('\n## Contacts\n'));
      expect(result.markdown, contains('Core hours are **10:00 to 16:00**, and the rest is flexible.'));
      expect(result.markdown, contains('\n- Stand-up at 10:15\n'));
      expect(result.markdown, contains('\n  - Fifteen minutes, standing\n'));
      expect(result.markdown, contains('| Platform | #platform |'));
      expect(result.markdown, contains('[Company wiki](https://wiki.example.com/)'));
    });
  });

  group('xlsx', () {
    test('converts every sheet, resolving shared strings and dates', () {
      final result = convert('sales.xlsx', makeXlsx());
      expect(result.markdown, contains('\n## Sales\n'));
      expect(result.markdown, contains('| Widget  | 1200  | 2024-01-15 |'));
      expect(result.markdown, contains('\n## Notes\n'));
      expect(result.markdown, contains('Prices exclude VAT'));
    });

    test('Google Sheets export resolves the unnumbered worksheet part', () {
      final result = convert('Budget.xlsx', makeGoogleSheetsXlsx());
      expect(result.format, 'Excel (.xlsx)');
      expect(result.markdown, contains('| Hosting | 240  |'));
      expect(result.markdown, contains('| Domains | 36   |'));
      expect(result.markdown.contains('Empty sheet'), isFalse);
    });
  });

  group('pptx', () {
    test('converts slides in order with bullets and speaker notes', () {
      final result = convert('deck.pptx', makePptx());
      expect(result.markdown, contains('\n## Roadmap\n'));
      expect(result.markdown, contains('\n- Ship the beta\n'));
      expect(result.markdown, contains('\n  - Nested detail\n'));
      expect(result.markdown, contains('Speaker notes:** Remember to mention the pilot.'));
      expect(result.markdown.indexOf('## Roadmap') < result.markdown.indexOf('## Timeline'), isTrue);
    });

    test('omits notes when the option is off', () {
      final result = convert('deck.pptx', makePptx(), options.copyWith(includeNotes: false));
      expect(result.markdown.contains('Speaker notes'), isFalse);
    });

    test('Google Slides export uses ctrTitle and indexed body placeholders', () {
      final result = convert('Launch plan.pptx', makeGoogleSlidesPptx());
      expect(result.markdown, contains('\n## Launch plan\n'));
      expect(result.markdown, contains('\n- Freeze scope\n'));
      expect(result.markdown, contains('\n  - Except security fixes\n'));
      expect(result.markdown, contains('\n- **Ship on the 20th**'));
    });
  });

  group('odf and epub', () {
    test('odt converts headings, styled spans, lists, links and tables', () {
      final result = convert('notes.odt', makeOdt());
      expect(result.markdown, contains('\n# Field Notes\n'));
      expect(result.markdown, contains('Recorded on **Tuesday** in *Erbil*.'));
      expect(result.markdown, contains('\n- Wind from the north\n'));
      expect(result.markdown, contains('[Source data](https://example.org)'));
      expect(result.markdown, contains('| Hour  | Temp |'));
    });

    test('epub converts chapters in spine order', () {
      final result = convert('book.epub', makeEpub());
      expect(result.markdown, contains('\n# Beginnings\n'));
      expect(result.markdown, contains('It started with a *question*.'));
      expect(result.markdown, contains('\n# Endings\n'));
      expect(result.markdown.indexOf('Beginnings') < result.markdown.indexOf('Endings'), isTrue);
      expect(result.markdown, contains('author: A. Author'));
    });
  });

  group('pdf', () {
    for (final compress in [false, true]) {
      test('extracts structured text (${compress ? 'compressed' : 'uncompressed'} streams)', () {
        final result = convert('report.pdf', makePdf(compress: compress));

        expect(result.format, 'PDF');
        expect(result.markdown, contains('\n# Quarterly Report\n'));
        expect(
          result.markdown,
          contains('This is the first paragraph of the report, wrapped across two lines.'),
        );
        expect(result.markdown, contains('\n- First bullet point\n'));
        expect(result.markdown, contains('\n- Second bullet point\n'));
        expect(result.markdown, contains('\n## Method\n'));
        expect(result.markdown, contains('Kerned words stay separate.'));
        expect(result.markdown, contains('pages: "1"'));
        expect(result.markdown, contains('author: Finance'));
      });
    }

    test('heading detection can be turned off', () {
      final result = convert('report.pdf', makePdf(), options.copyWith(detectPdfHeadings: false));
      expect(result.markdown.contains('# Quarterly Report'), isFalse);
      expect(result.markdown, contains('Quarterly Report'));
    });
  });

  group('rtf, html, email, csv and text', () {
    test('rtf converts formatting, lists and escapes', () {
      final result = convert('notes.rtf', makeRtf());
      expect(result.markdown, contains('\n# Meeting notes\n'));
      expect(result.markdown, contains('**budget**'));
      expect(result.markdown, contains('*timeline*'));
      expect(result.markdown, contains('\n- Review vendor quotes\n'));
      expect(result.markdown, contains('Café costs were €120.'));
    });

    test('html converts structure, nested lists, code and tables', () {
      final result = convert('notes.html', makeHtml());
      expect(result.markdown, contains('\n# Release notes\n'));
      expect(result.markdown, contains('Version **2.1** is out.'));
      expect(result.markdown, contains('[changelog](https://example.com/changelog)'));
      expect(result.markdown, contains('\n- Faster startup\n'));
      expect(result.markdown, contains('\n  - on Windows\n'));
      expect(result.markdown, contains('\n> Upgrading is recommended.'));
      expect(result.markdown, contains('| Platform | Status  |'));
      expect(result.markdown, contains('```bash\nnpm install app@2.1\n```'));
    });

    test('Google Docs HTML export restores emphasis carried by CSS classes', () {
      final result = convert('Meeting notes.html', makeGoogleDocsHtml());
      expect(result.markdown, contains('\n# Meeting notes\n'));
      expect(result.markdown, contains('Attendees: **Ameen**, Sara.'));
      expect(result.markdown, contains('\n- Confirm the budget\n'));
      expect(result.markdown, contains('\n  - Check parking\n'));
    });

    test('eml decodes encoded headers and prefers the html body', () {
      final result = convert('message.eml', makeEml());
      expect(result.markdown, contains('\n# Quarterly update\n'));
      expect(result.markdown, contains(r'"Ameen Marashi" \<ameen@example.com\>'));
      expect(result.markdown, contains('Numbers are **up** — details inside.'));
    });

    test('csv sniffs the delimiter and handles quoted fields', () {
      expect(sniffDelimiter('a;b;c\n1;2;3'), ';');
      expect(parseDelimited('a,"b,c",d', ','), [
        ['a', 'b,c', 'd']
      ]);

      final result = convert('sales.csv', makeCsv());
      expect(result.markdown, contains('North, America'));
      expect(result.meta['delimiter'], ';');
    });

    test('plain text gains structure without a code fence', () {
      const source = 'PROJECT PLAN\n\nOverview\n========\n\nFirst line\nsecond line.\n\n- alpha\n- beta';
      final result = convert('plan.txt', source);
      expect(result.markdown, contains('\n## PROJECT PLAN\n'));
      expect(result.markdown, contains('\n# Overview\n'));
      expect(result.markdown, contains('First line second line.'));
      expect(result.markdown, contains('\n- alpha\n'));
    });

    test('markdown input passes through unchanged apart from front matter', () {
      final result = convert(
        'readme.md',
        '# Title\n\nBody **text**.\n',
        options.copyWith(frontMatter: false),
      );
      expect(result.markdown, '# Title\n\nBody **text**.\n');
    });

    test('json arrays of flat objects become tables', () {
      final result = convert('rows.json', '[{"id":1,"name":"a"},{"id":2,"name":"b"}]');
      expect(result.markdown, contains('| id  | name |'));
      expect(result.markdown, contains('| 2   | b    |'));
    });
  });

  group('dispatch', () {
    test('format detection is content-first', () {
      expect(detectFormat(sourceFile('mislabelled.doc', makeDocx())).id, FormatId.docx);
      expect(detectFormat(sourceFile('report.bin', makePdf())).id, FormatId.pdf);
      expect(detectFormat(sourceFile('page.htm', '<html><body>hi</body></html>')).id, FormatId.html);
      expect(detectFormat(sourceFile('data.csv', 'a,b\n1,2')).id, FormatId.csv);
    });

    test('legacy binary Office files get an actionable message', () {
      final ole = bytesOf('x' * 600);
      for (final entry in [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].asMap().entries) {
        ole[entry.key] = entry.value;
      }
      expect(
        () => convert('old.doc', ole),
        throwsA(isA<ConversionException>().having((e) => e.message, 'message', contains('.docx'))),
      );
    });

    test('Google Drive shortcut files explain how to download the real document', () {
      expect(
        () => convert('Team Handbook.gdoc', makeGdocShortcut()),
        throwsA(isA<ConversionException>()
            .having((e) => e.message, 'message', contains('Microsoft Word (.docx)'))),
      );
      expect(
        () => convert('Budget.gsheet', makeGdocShortcut()),
        throwsA(isA<ConversionException>()
            .having((e) => e.message, 'message', contains('Microsoft Excel (.xlsx)'))),
      );
      expect(
        () => convert('Deck.gslides', makeGdocShortcut()),
        throwsA(isA<ConversionException>()
            .having((e) => e.message, 'message', contains('Microsoft PowerPoint (.pptx)'))),
      );
    });

    test('front matter can be switched off', () {
      final result = convert('review.docx', makeDocx(), options.copyWith(frontMatter: false));
      expect(result.markdown.startsWith('---'), isFalse);
      expect(result.outputName, 'review.md');
    });
  });
}
