import 'package:xml/xml.dart';

/// Namespace-tolerant queries over `package:xml`.
///
/// A query containing a colon matches the qualified name (`w:p`); otherwise it
/// matches the local name, which keeps the converters readable when the same
/// element appears under different prefixes.
bool _matches(XmlElement element, String query) {
  return query.contains(':')
      ? element.name.qualified == query
      : element.name.local == query;
}

List<XmlElement> childrenOf(XmlElement element, [String? query]) {
  final out = <XmlElement>[];
  for (final node in element.children) {
    if (node is XmlElement && (query == null || _matches(node, query))) out.add(node);
  }
  return out;
}

XmlElement? childOf(XmlElement element, String query) {
  for (final node in element.children) {
    if (node is XmlElement && _matches(node, query)) return node;
  }
  return null;
}

List<XmlElement> descendantsOf(XmlElement element, String query) {
  final out = <XmlElement>[];
  void walk(XmlElement node) {
    for (final child in node.children) {
      if (child is! XmlElement) continue;
      if (_matches(child, query)) out.add(child);
      walk(child);
    }
  }

  walk(element);
  return out;
}

XmlElement? firstDescendantOf(XmlElement element, String query) {
  for (final child in element.children) {
    if (child is! XmlElement) continue;
    if (_matches(child, query)) return child;
    final found = firstDescendantOf(child, query);
    if (found != null) return found;
  }
  return null;
}

/// Attribute lookup that ignores namespace prefixes when the query has none.
String? attrOf(XmlElement element, String query) {
  for (final attribute in element.attributes) {
    if (attribute.name.qualified == query) return attribute.value;
  }
  if (query.contains(':')) return null;
  for (final attribute in element.attributes) {
    if (attribute.name.local == query) return attribute.value;
  }
  return null;
}

String textOf(XmlNode node) => node.innerText;

/// Parses a package part, returning null instead of throwing on malformed XML.
XmlElement? parseRoot(String? source) {
  if (source == null || source.trim().isEmpty) return null;
  try {
    return XmlDocument.parse(source).rootElement;
  } on XmlException {
    return null;
  }
}
