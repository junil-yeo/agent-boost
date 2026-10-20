// SF Symbol names → inline SVG icons, so views ported from SwiftUI can keep writing the Swift symbol name:
//   Icon({ name: 'arrow.up' })           (widgets.js renders it)
//   iconSVG('arrow.up')                   (an <svg> string, for places outside Preact)
//
// The shapes are Lucide icons (lucide-static 0.460.0, https://lucide.dev), ISC License:
//   Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other
//   copyright (c) for Lucide are held by Lucide Contributors 2022. Permission to use, copy, modify, and/or distribute
//   this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and
//   this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL
//   WARRANTIES WITH REGARD TO THIS SOFTWARE.
//
// GENERATED element lists (LUCIDE) — each is the inner markup of one 24×24 Lucide icon, one string per element.
// The SF table below (SF) is hand-written: which Lucide icon stands for each SF Symbol the Swift sources use, and how
// SF's ".fill" variants are drawn (some elements filled, inner glyphs knocked out through a mask so they stay
// transparent, as SF draws them).

const LUCIDE = {
  'app-window': ["<rect x=\"2\" y=\"4\" width=\"20\" height=\"16\" rx=\"2\"/>","<path d=\"M10 4v4\"/>","<path d=\"M2 8h20\"/>","<path d=\"M6 4v4\"/>"],
  'archive': ["<rect width=\"20\" height=\"5\" x=\"2\" y=\"3\" rx=\"1\"/>","<path d=\"M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8\"/>","<path d=\"M10 12h4\"/>"],
  'arrow-up-right': ["<path d=\"M7 7h10v10\"/>","<path d=\"M7 17 17 7\"/>"],
  'arrow-up': ["<path d=\"m5 12 7-7 7 7\"/>","<path d=\"M12 19V5\"/>"],
  'bell-off': ["<path d=\"M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5\"/>","<path d=\"M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7\"/>","<path d=\"M10.3 21a1.94 1.94 0 0 0 3.4 0\"/>","<path d=\"m2 2 20 20\"/>"],
  'bell': ["<path d=\"M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9\"/>","<path d=\"M10.3 21a1.94 1.94 0 0 0 3.4 0\"/>"],
  'check': ["<path d=\"M20 6 9 17l-5-5\"/>"],
  'chevron-down': ["<path d=\"m6 9 6 6 6-6\"/>"],
  'chevron-right': ["<path d=\"m9 18 6-6-6-6\"/>"],
  'circle-arrow-down': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>","<path d=\"M12 8v8\"/>","<path d=\"m8 12 4 4 4-4\"/>"],
  'circle-arrow-right': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>","<path d=\"M8 12h8\"/>","<path d=\"m12 16 4-4-4-4\"/>"],
  'circle-check': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>","<path d=\"m9 12 2 2 4-4\"/>"],
  'circle-minus': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>","<path d=\"M8 12h8\"/>"],
  'circle-plus': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>","<path d=\"M8 12h8\"/>","<path d=\"M12 8v8\"/>"],
  'circle-user': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>","<circle cx=\"12\" cy=\"10\" r=\"3\"/>","<path d=\"M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662\"/>"],
  'circle-x': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>","<path d=\"m15 9-6 6\"/>","<path d=\"m9 9 6 6\"/>"],
  'circle': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>"],
  'clock': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>","<polyline points=\"12 6 12 12 16 14\"/>"],
  'cloud': ["<path d=\"M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z\"/>"],
  'copy': ["<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/>","<path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>"],
  'corner-down-right': ["<polyline points=\"15 10 20 15 15 20\"/>","<path d=\"M4 4v7a4 4 0 0 0 4 4h12\"/>"],
  'git-branch': ["<line x1=\"6\" x2=\"6\" y1=\"3\" y2=\"15\"/>","<circle cx=\"18\" cy=\"6\" r=\"3\"/>","<circle cx=\"6\" cy=\"18\" r=\"3\"/>","<path d=\"M18 9a9 9 0 0 1-9 9\"/>"],
  'list': ["<path d=\"M3 12h.01\"/>","<path d=\"M3 18h.01\"/>","<path d=\"M3 6h.01\"/>","<path d=\"M8 12h13\"/>","<path d=\"M8 18h13\"/>","<path d=\"M8 6h13\"/>"],
  'pin': ["<path d=\"M12 17v5\"/>","<path d=\"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z\"/>"],
  'pin-off': ["<path d=\"M12 17v5\"/>","<path d=\"M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89\"/>","<path d=\"m2 2 20 20\"/>","<path d=\"M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11\"/>"],
  'ellipsis': ["<circle cx=\"12\" cy=\"12\" r=\"1\"/>","<circle cx=\"19\" cy=\"12\" r=\"1\"/>","<circle cx=\"5\" cy=\"12\" r=\"1\"/>"],
  'eye': ["<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\"/>","<circle cx=\"12\" cy=\"12\" r=\"3\"/>"],
  'file-text': ["<path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/>","<path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/>","<path d=\"M10 9H8\"/>","<path d=\"M16 13H8\"/>","<path d=\"M16 17H8\"/>"],
  'folder': ["<path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/>"],
  'forward': ["<polyline points=\"15 17 20 12 15 7\"/>","<path d=\"M4 18v-2a4 4 0 0 1 4-4h12\"/>"],
  'globe': ["<circle cx=\"12\" cy=\"12\" r=\"10\"/>","<path d=\"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20\"/>","<path d=\"M2 12h20\"/>"],
  'hand': ["<path d=\"M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2\"/>","<path d=\"M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2\"/>","<path d=\"M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8\"/>","<path d=\"M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15\"/>"],
  'hard-drive': ["<line x1=\"22\" x2=\"2\" y1=\"12\" y2=\"12\"/>","<path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"/>","<line x1=\"6\" x2=\"6.01\" y1=\"16\" y2=\"16\"/>","<line x1=\"10\" x2=\"10.01\" y1=\"16\" y2=\"16\"/>"],
  'hourglass': ["<path d=\"M5 22h14\"/>","<path d=\"M5 2h14\"/>","<path d=\"M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22\"/>","<path d=\"M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2\"/>"],
  'inbox': ["<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\"/>","<path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\"/>"],
  'keyboard': ["<path d=\"M10 8h.01\"/>","<path d=\"M12 12h.01\"/>","<path d=\"M14 8h.01\"/>","<path d=\"M16 12h.01\"/>","<path d=\"M18 8h.01\"/>","<path d=\"M6 8h.01\"/>","<path d=\"M7 16h10\"/>","<path d=\"M8 12h.01\"/>","<rect width=\"20\" height=\"16\" x=\"2\" y=\"4\" rx=\"2\"/>"],
  'layers': ["<path d=\"m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z\"/>","<path d=\"m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65\"/>","<path d=\"m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65\"/>"],
  'list-checks': ["<path d=\"m3 17 2 2 4-4\"/>","<path d=\"m3 7 2 2 4-4\"/>","<path d=\"M13 6h8\"/>","<path d=\"M13 12h8\"/>","<path d=\"M13 18h8\"/>"],
  'lock': ["<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/>","<path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>"],
  'menu': ["<line x1=\"4\" x2=\"20\" y1=\"12\" y2=\"12\"/>","<line x1=\"4\" x2=\"20\" y1=\"6\" y2=\"6\"/>","<line x1=\"4\" x2=\"20\" y1=\"18\" y2=\"18\"/>"],
  'monitor': ["<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"/>","<line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"/>","<line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"/>"],
  'moon-star': ["<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9\"/>","<path d=\"M20 3v4\"/>","<path d=\"M22 5h-4\"/>"],
  'moon': ["<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"/>"],
  'network': ["<rect x=\"16\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/>","<rect x=\"2\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/>","<rect x=\"9\" y=\"2\" width=\"6\" height=\"6\" rx=\"1\"/>","<path d=\"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3\"/>","<path d=\"M12 12V8\"/>"],
  'octagon-alert': ["<path d=\"M12 16h.01\"/>","<path d=\"M12 8v4\"/>","<path d=\"M15.312 2a2 2 0 0 1 1.414.586l4.688 4.688A2 2 0 0 1 22 8.688v6.624a2 2 0 0 1-.586 1.414l-4.688 4.688a2 2 0 0 1-1.414.586H8.688a2 2 0 0 1-1.414-.586l-4.688-4.688A2 2 0 0 1 2 15.312V8.688a2 2 0 0 1 .586-1.414l4.688-4.688A2 2 0 0 1 8.688 2z\"/>"],
  'paperclip': ["<path d=\"m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48\"/>"],
  'pencil': ["<path d=\"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z\"/>","<path d=\"m15 5 4 4\"/>"],
  'plus': ["<path d=\"M5 12h14\"/>","<path d=\"M12 5v14\"/>"],
  'power': ["<path d=\"M12 2v10\"/>","<path d=\"M18.4 6.6a9 9 0 1 1-12.77.04\"/>"],
  'radio': ["<path d=\"M4.9 19.1C1 15.2 1 8.8 4.9 4.9\"/>","<path d=\"M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5\"/>","<circle cx=\"12\" cy=\"12\" r=\"2\"/>","<path d=\"M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5\"/>","<path d=\"M19.1 4.9C23 8.8 23 15.1 19.1 19\"/>"],
  'rotate-cw': ["<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\"/>","<path d=\"M21 3v5h-5\"/>"],
  'search': ["<circle cx=\"11\" cy=\"11\" r=\"8\"/>","<path d=\"m21 21-4.3-4.3\"/>"],
  'send': ["<path d=\"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z\"/>","<path d=\"m21.854 2.147-10.94 10.939\"/>"],
  'sparkles': ["<path d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\"/>","<path d=\"M20 3v4\"/>","<path d=\"M22 5h-4\"/>","<path d=\"M4 17v2\"/>","<path d=\"M5 18H3\"/>"],
  'square-arrow-out-up-right': ["<path d=\"M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6\"/>","<path d=\"m21 3-9 9\"/>","<path d=\"M15 3h6v6\"/>"],
  'square-check': ["<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>","<path d=\"m9 12 2 2 4-4\"/>"],
  'square-menu': ["<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>","<path d=\"M7 8h10\"/>","<path d=\"M7 12h10\"/>","<path d=\"M7 16h10\"/>"],
  'square-terminal': ["<path d=\"m7 11 2-2-2-2\"/>","<path d=\"M11 13h4\"/>","<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"/>"],
  'square-user': ["<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>","<circle cx=\"12\" cy=\"10\" r=\"3\"/>","<path d=\"M7 21v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2\"/>"],
  'square': ["<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/>"],
  'sun': ["<circle cx=\"12\" cy=\"12\" r=\"4\"/>","<path d=\"M12 2v2\"/>","<path d=\"M12 20v2\"/>","<path d=\"m4.93 4.93 1.41 1.41\"/>","<path d=\"m17.66 17.66 1.41 1.41\"/>","<path d=\"M2 12h2\"/>","<path d=\"M20 12h2\"/>","<path d=\"m6.34 17.66-1.41 1.41\"/>","<path d=\"m19.07 4.93-1.41 1.41\"/>"],
  'trash-2': ["<path d=\"M3 6h18\"/>","<path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/>","<path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/>","<line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\"/>","<line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\"/>"],
  'triangle-alert': ["<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/>","<path d=\"M12 9v4\"/>","<path d=\"M12 17h.01\"/>"],
  'undo-2': ["<path d=\"M9 14 4 9l5-5\"/>","<path d=\"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11\"/>"],
  'user-plus': ["<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/>","<circle cx=\"9\" cy=\"7\" r=\"4\"/>","<line x1=\"19\" x2=\"19\" y1=\"8\" y2=\"14\"/>","<line x1=\"22\" x2=\"16\" y1=\"11\" y2=\"11\"/>"],
  'user': ["<path d=\"M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2\"/>","<circle cx=\"12\" cy=\"7\" r=\"4\"/>"],
  'users': ["<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/>","<circle cx=\"9\" cy=\"7\" r=\"4\"/>","<path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/>","<path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>"],
  'wrench': ["<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z\"/>"],
  'x': ["<path d=\"M18 6 6 18\"/>","<path d=\"m6 6 12 12\"/>"],
};

/**
 * Every SF Symbol name used in Sources/AgentBoost/*.swift (systemImage:, Image(systemName:), TabButton icon:,
 * ToolLine icon:, NSImage(systemSymbolName:)), mapped to a Lucide icon.
 *   l       Lucide icon name (key of LUCIDE)
 *   fill    indexes of elements drawn filled (SF ".fill")
 *   knock   indexes of elements cut out of the filled ones (the check in checkmark.circle.fill …)
 *   extra   additional elements (a slash, a "z") drawn after the icon
 *   rotate  degrees around the centre
 *   sw      stroke width (default 2)
 */
export const SF = {
  'antenna.radiowaves.left.and.right': { l: 'radio' },
  'antenna.radiowaves.left.and.right.slash': { l: 'radio', extra: ['<path d="m2 2 20 20"/>'] },
  'apple.terminal': { l: 'square-terminal' },
  'archivebox': { l: 'archive' },
  'arrow.clockwise': { l: 'rotate-cw' },
  'arrow.down.circle': { l: 'circle-arrow-down' },
  'arrow.right.circle': { l: 'circle-arrow-right' },
  'arrow.turn.down.right': { l: 'corner-down-right' },
  'arrow.up': { l: 'arrow-up' },
  'arrow.up.forward.app': { l: 'square-arrow-out-up-right' },
  'arrow.up.right': { l: 'arrow-up-right' },
  'arrow.uturn.backward': { l: 'undo-2' },
  'arrow.uturn.down': { l: 'undo-2', rotate: -90 },
  'arrowshape.turn.up.right': { l: 'forward' },
  'bell.fill': { l: 'bell', fill: [0] },
  'bell.slash': { l: 'bell-off' },
  'checklist': { l: 'list-checks' },
  'checkmark': { l: 'check' },
  'checkmark.circle.fill': { l: 'circle-check', fill: [0], knock: [1] },
  'checkmark.square': { l: 'square-check' },
  'checkmark.square.fill': { l: 'square-check', fill: [0], knock: [1] },
  'chevron.down': { l: 'chevron-down' },
  'chevron.right': { l: 'chevron-right' },
  'circle': { l: 'circle' },
  'clock': { l: 'clock' },
  'cloud': { l: 'cloud' },
  'desktopcomputer': { l: 'monitor' },
  'doc.on.doc': { l: 'copy' },
  'doc.text': { l: 'file-text' },
  'ellipsis': { l: 'ellipsis' },
  'exclamationmark.octagon': { l: 'octagon-alert' },
  'exclamationmark.triangle': { l: 'triangle-alert' },
  'exclamationmark.triangle.fill': { l: 'triangle-alert', fill: [0], knock: [1, 2] },
  'eye': { l: 'eye' },
  'folder': { l: 'folder' },
  'globe': { l: 'globe' },
  'hand.raised.fill': { l: 'hand', sw: 2.6 },
  'hourglass': { l: 'hourglass' },
  'internaldrive': { l: 'hard-drive' },
  'keyboard': { l: 'keyboard' },
  'line.3.horizontal': { l: 'menu' },
  'branch': { l: 'git-branch' },
  'list.bullet': { l: 'list' },
  'list.bullet.rectangle': { l: 'square-menu' },
  'lock.fill': { l: 'lock', fill: [0] },
  'macwindow.badge.plus': { l: 'app-window' },
  'magnifyingglass': { l: 'search' },
  'minus.circle': { l: 'circle-minus' },
  'moon': { l: 'moon' },
  'moon.stars': { l: 'moon-star' },
  'moon.zzz': { l: 'moon', extra: ['<path d="M16 2.5h5l-5 5h5"/>'] },
  'paperclip': { l: 'paperclip' },
  'paperplane.fill': { l: 'send', fill: [0], knock: [1] },
  'pencil': { l: 'pencil' },
  'person': { l: 'user' },
  'person.3': { l: 'users' },
  'person.badge.plus': { l: 'user-plus' },
  'person.crop.circle.badge.exclamationmark': { l: 'circle-user' },
  'person.crop.rectangle': { l: 'square-user' },
  'plus': { l: 'plus' },
  'plus.circle': { l: 'circle-plus' },
  'power': { l: 'power' },
  'pin': { l: 'pin' },
  'pin.fill': { l: 'pin', fill: [1] },
  'pin.slash': { l: 'pin-off' },
  'rectangle.3.group': { l: 'network' },
  'sparkles': { l: 'sparkles' },
  'stop.fill': { l: 'square', fill: [0] },
  'sun.max': { l: 'sun' },
  'terminal': { l: 'square-terminal' },
  'trash': { l: 'trash-2' },
  'trash.slash': { l: 'trash-2', extra: ['<path d="m2 2 20 20"/>'] },
  'tray.2': { l: 'layers' },
  'tray.full': { l: 'inbox' },
  'wrench.and.screwdriver': { l: 'wrench' },
  'xmark': { l: 'x' },
  'xmark.circle': { l: 'circle-x' },
  'xmark.circle.fill': { l: 'circle-x', fill: [0], knock: [1, 2] },
};

/** All SF names that have an icon (for the gallery). */
export const iconNames = Object.keys(SF);

let maskSeq = 0;
/** A fresh id for a knock-out mask (the Icon component takes one per instance and keeps it across redraws). */
export function nextMaskId() { return `abm${++maskSeq}`; }
/**
 * Inner markup (inside a 0 0 24 24 <svg>) for an SF Symbol name, or a Lucide name. Unknown names draw a dotted
 * square and warn once, so a missing mapping shows up instead of leaving a gap. `maskId`: id for the knock-out mask
 * of filled variants (unique in the document; a new one when omitted).
 */
export function iconMarkup(name, maskId) {
  const spec = SF[name] || (LUCIDE[name] ? { l: name } : null);
  if (!spec) {
    if (!warned.has(name)) { warned.add(name); console.warn(`[icons] no icon for SF Symbol "${name}"`); }
    return '<rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="2 2"/>';
  }
  const els = LUCIDE[spec.l] || [];
  const fill = new Set(spec.fill || []), knock = new Set(spec.knock || []);
  let body;
  if (knock.size) {
    // filled shape with transparent glyph: the glyph's strokes cut the fill through a mask
    const id = maskId || nextMaskId();
    const cut = els.filter((_, i) => knock.has(i)).join('');
    const solid = els.filter((_, i) => !knock.has(i)).map((e) => (fill.has(els.indexOf(e)) ? e.replace(/^<(\w+)/, '<$1 fill="currentColor"') : e)).join('');
    body = `<mask id="${id}" maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28"><rect x="-2" y="-2" width="28" height="28" fill="#fff" stroke="none"/><g stroke="#000" stroke-width="2.4">${cut}</g></mask><g mask="url(#${id})">${solid}</g>`;
  } else {
    body = els.map((e, i) => (fill.has(i) ? e.replace(/^<(\w+)/, '<$1 fill="currentColor"') : e)).join('');
  }
  if (spec.extra) body += spec.extra.join('');
  if (spec.rotate) body = `<g transform="rotate(${spec.rotate} 12 12)">${body}</g>`;
  return body;
}
const warned = new Set();

/** Stroke width for a name (SF ".fill" hands are drawn bolder). */
export function iconStroke(name) { return (SF[name] && SF[name].sw) || 2; }

/** A complete <svg> string for an SF Symbol name (size in px; colour = currentColor). */
export function iconSVG(name, size = 16) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${iconStroke(name)}" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(name)}</svg>`;
}
