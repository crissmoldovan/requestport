#!/usr/bin/env node
/**
 * G.A's third-party licence inventory (Plan 13: `manifest-g.md` §0.4 and
 * Appendix B, ruling 70). For each candidate package and candidate set it
 * reports the distinct third-party packages in the closure, their licences
 * counted by the expression each `name@version` declares, and every flagged
 * package with the workspace packages that pull it in and one dependency path.
 *
 * It is an input to the owner's licence decision (D3). It chooses no licence
 * and judges no compatibility between licences: that is counsel's and the
 * owner's.
 *
 * Offline. The script writes nothing but its own output: the summary on
 * stdout, and the JSON document where `--json` says. It reads
 * `pnpm-workspace.yaml`, `package.json` files, licence files and directory
 * listings, and spawns one program, pnpm, for view (a) only, with the
 * registry pointed at a closed port and corepack's network switched off.
 * pnpm itself writes while it runs. Each call (pnpm 11.22.0) creates a file
 * in the project root and a directory in its own home directory, links the
 * one into the other, and removes both: its check, before it picks where its
 * store lives, that it can hard-link between the two. And it opens its store
 * index, a SQLite database, read-write, in WAL mode.
 *
 * Two views (§0.4, B.1):
 *
 * (a) pnpm's report: the union of `pnpm --filter <p> licenses list --json
 *     --prod` over every workspace package in the closure. pnpm's report for
 *     one package does not descend into its workspace dependencies, so a
 *     closure's report is the union of its members' reports. It needs a pnpm
 *     workspace, a `pnpm-workspace.yaml` with a `packages:` list, and is not
 *     run without one.
 * (b) what a consumer installs: a walk by Node's resolution from each
 *     package's real path, following `dependencies`, `optionalDependencies`
 *     and the `peerDependencies` not marked optional. The optional peers that
 *     this tree happens to install are left out, and named. It needs neither
 *     pnpm nor a workspace, so it also runs over a plain installed
 *     `node_modules` (G.8's tarball consumer, and J before publishing). A
 *     root whose `pnpm-workspace.yaml` has no `packages:` list, as that
 *     consumer's, which holds only its overrides, is read as such a tree.
 *
 * A third walk, the same as (b) but following the installed optional peers
 * too, is what view (a) is checked against. pnpm's report names no
 * dependency path, so a package view (b) does not hold is shown with this
 * walk's path. The platform binaries and their linux-x64 counterparts are
 * read from this walk too.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** Where pnpm is told the registry is: a closed port, so it can reach none. */
export const CLOSED_REGISTRY = "http://127.0.0.1:9/";

/**
 * The copyleft families G.A flags (§0.4), matched against the front of an
 * SPDX identifier: `LGPL-2.1-only`, `MPL-2.0`, `GPL-2.0+` and so on. An
 * identifier of one of these families is flagged `copyleft` whether or not
 * SPDX lists it, and `unknown` as well when SPDX does not.
 */
export const COPYLEFT_FAMILIES = [
  "AGPL",
  "CDDL",
  "EPL",
  "EUPL",
  "GPL",
  "LGPL",
  "MPL",
  "OSL",
];

const COPYLEFT_IDENTIFIER = new RegExp(
  `^(${COPYLEFT_FAMILIES.join("|")})(?:-|$)`,
  "iu",
);

/**
 * The identifiers this classifier knows to be none of the things §0.4 flags:
 * permissive licences, Creative Commons attribution licences and
 * public-domain dedications. It is what the classifier knows, not every
 * licence that is not copyleft, and not a judgement that any of them suits an
 * outbound licence. An identifier SPDX lists that is in neither this list nor
 * the copyleft families is flagged `unclassified`, with the identifier, for
 * counsel to read (ruling 105).
 */
export const RECOGNISED_IDENTIFIERS = [
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC-BY-3.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "Python-2.0",
  "Unlicense",
  "WTFPL",
  "Zlib",
];

/**
 * The licence exceptions this classifier knows to grant permissions beyond
 * the licence they modify. One of them adds no flag of its own: the licence
 * it modifies is classified as it would be without it, so
 * `GPL-2.0-only WITH Classpath-exception-2.0` is `copyleft`. What the
 * exception changes about that licence is counsel's to read. An exception
 * SPDX lists that is not here is flagged `unclassified`, as an identifier is.
 */
export const RECOGNISED_EXCEPTIONS = [
  "Autoconf-exception-2.0",
  "Autoconf-exception-3.0",
  "Bison-exception-2.2",
  "Classpath-exception-2.0",
  "Font-exception-2.0",
  "GCC-exception-2.0",
  "GCC-exception-3.1",
  "Libtool-exception",
  "Linux-syscall-note",
  "LLVM-exception",
];

/**
 * Every licence identifier on the SPDX License List, current and deprecated:
 * `index.json` (708) then `deprecated.json` (26) of `spdx-license-ids@3.0.24`
 * (CC0-1.0), read from its tarball on registry.npmjs.org, whose sha512 is
 * the registry's integrity for it. An identifier outside this list is not
 * one SPDX defines, so the expression is not a valid SPDX expression, and it
 * is flagged `unknown` (ruling 105). So is an identifier SPDX adds after that
 * version, until this list is refreshed.
 */
export const SPDX_LICENCE_IDENTIFIERS = Object.freeze(
  `
0BSD 3D-Slicer-1.0 AAL ADSL AFL-1.1 AFL-1.2 AFL-2.0 AFL-2.1 AFL-3.0
AGPL-1.0-only AGPL-1.0-or-later AGPL-3.0-only AGPL-3.0-or-later
ALGLIB-Documentation AMD-newlib AMDPLPA AML AML-glslang AMPAS ANTLR-PD
ANTLR-PD-fallback APAFML APL-1.0 APSL-1.0 APSL-1.1 APSL-1.2 APSL-2.0
ASWF-Digital-Assets-1.0 ASWF-Digital-Assets-1.1 Abstyles AdaCore-doc
Adobe-2006 Adobe-Display-PostScript Adobe-Glyph Adobe-Utopia
Advanced-Cryptics-Dictionary Afmparse Aladdin Apache-1.0 Apache-1.1
Apache-2.0 App-s2p Arphic-1999 Artistic-1.0 Artistic-1.0-Perl
Artistic-1.0-cl8 Artistic-2.0 Artistic-dist Aspell-RU BOLA-1.1 BSD-1-Clause
BSD-2-Clause BSD-2-Clause-Darwin BSD-2-Clause-Patent BSD-2-Clause-Views
BSD-2-Clause-first-lines BSD-2-Clause-pkgconf-disclaimer
BSD-2-Clause-pos-unchanged BSD-3-Clause BSD-3-Clause-Attribution
BSD-3-Clause-Clear BSD-3-Clause-HP BSD-3-Clause-LBNL
BSD-3-Clause-Modification BSD-3-Clause-No-Military-License
BSD-3-Clause-No-Nuclear-License BSD-3-Clause-No-Nuclear-License-2014
BSD-3-Clause-No-Nuclear-Warranty BSD-3-Clause-Open-MPI
BSD-3-Clause-OpenWebUI BSD-3-Clause-Sun BSD-3-Clause-Tso BSD-3-Clause-acpica
BSD-3-Clause-flex BSD-4-Clause BSD-4-Clause-Shortened BSD-4-Clause-UC
BSD-4.3RENO BSD-4.3TAHOE BSD-Advertising-Acknowledgement
BSD-Attribution-HPND-disclaimer BSD-Inferno-Nettverk BSD-Mark-Modifications
BSD-Protection BSD-Source-Code BSD-Source-Code-no-disclaimer
BSD-Source-alt-GPL BSD-Source-beginning-file BSD-Systemics
BSD-Systemics-W3Works BSD-ask-to-endorse BSL-1.0 BUSL-1.1 Baekmuk Bahyph
Barr Beerware BitTorrent-1.0 BitTorrent-1.1 Bitstream-Charter Bitstream-Vera
BlueOak-1.0.0 Boehm-GC Boehm-GC-without-fee Borceux Brian-Gladman-2-Clause
Brian-Gladman-3-Clause Brian-Gladman-3-Clause-no-conversion Buddy Bugroff
C-UDA-1.0 CAL-1.0 CAL-1.0-Combined-Work-Exception CAPEC-tou CATOSL-1.1
CC-BY-1.0 CC-BY-2.0 CC-BY-2.5 CC-BY-2.5-AU CC-BY-3.0 CC-BY-3.0-AT
CC-BY-3.0-AU CC-BY-3.0-DE CC-BY-3.0-IGO CC-BY-3.0-NL CC-BY-3.0-US CC-BY-4.0
CC-BY-NC-1.0 CC-BY-NC-2.0 CC-BY-NC-2.5 CC-BY-NC-3.0 CC-BY-NC-3.0-DE
CC-BY-NC-3.0-IGO CC-BY-NC-4.0 CC-BY-NC-ND-1.0 CC-BY-NC-ND-2.0
CC-BY-NC-ND-2.5 CC-BY-NC-ND-3.0 CC-BY-NC-ND-3.0-DE CC-BY-NC-ND-3.0-IGO
CC-BY-NC-ND-4.0 CC-BY-NC-SA-1.0 CC-BY-NC-SA-2.0 CC-BY-NC-SA-2.0-DE
CC-BY-NC-SA-2.0-FR CC-BY-NC-SA-2.0-UK CC-BY-NC-SA-2.5 CC-BY-NC-SA-3.0
CC-BY-NC-SA-3.0-DE CC-BY-NC-SA-3.0-IGO CC-BY-NC-SA-4.0 CC-BY-ND-1.0
CC-BY-ND-2.0 CC-BY-ND-2.5 CC-BY-ND-3.0 CC-BY-ND-3.0-DE CC-BY-ND-4.0
CC-BY-SA-1.0 CC-BY-SA-2.0 CC-BY-SA-2.0-UK CC-BY-SA-2.1-JP CC-BY-SA-2.5
CC-BY-SA-3.0 CC-BY-SA-3.0-AT CC-BY-SA-3.0-DE CC-BY-SA-3.0-IGO CC-BY-SA-4.0
CC-PDDC CC-PDM-1.0 CC-SA-1.0 CC0-1.0 CDDL-1.0 CDDL-1.1 CDL-1.0
CDLA-Permissive-1.0 CDLA-Permissive-2.0 CDLA-Sharing-1.0 CECILL-1.0
CECILL-1.1 CECILL-2.0 CECILL-2.1 CECILL-B CECILL-C CERN-OHL-1.1 CERN-OHL-1.2
CERN-OHL-P-2.0 CERN-OHL-S-2.0 CERN-OHL-W-2.0 CFITSIO CMU-Mach CMU-Mach-nodoc
CNRI-Jython CNRI-Python CNRI-Python-GPL-Compatible COIL-1.0 CPAL-1.0 CPL-1.0
CPOL-1.02 CUA-OPL-1.0 Caldera Caldera-no-preamble Catharon ClArtistic Clips
Community-Spec-1.0 Condor-1.1 Cornell-Lossless-JPEG Cronyx Crossword
CryptoSwift CrystalStacker Cube D-FSL-1.0 DEC-3-Clause DL-DE-BY-2.0
DL-DE-ZERO-2.0 DOC DRL-1.0 DRL-1.1 DSDP DocBook-DTD DocBook-Schema
DocBook-Stylesheet DocBook-XML Dotseqn ECL-1.0 ECL-2.0 EFL-1.0 EFL-2.0 EPICS
EPL-1.0 EPL-2.0 ESA-PL-permissive-2.4 ESA-PL-strong-copyleft-2.4
ESA-PL-weak-copyleft-2.4 EUDatagrid EUPL-1.0 EUPL-1.1 EUPL-1.2 Elastic-2.0
Entessa ErlPL-1.1 Eurosym FBM FDK-AAC FDK-MPEG-H FSFAP
FSFAP-no-warranty-disclaimer FSFUL FSFULLR FSFULLRSD FSFULLRWD FSL-1.1-ALv2
FSL-1.1-MIT FTL Fair Ferguson-Twofish Frameworx-1.0 FreeBSD-DOC FreeImage
Furuseth GCR-docs GD GFDL-1.1-invariants-only GFDL-1.1-invariants-or-later
GFDL-1.1-no-invariants-only GFDL-1.1-no-invariants-or-later GFDL-1.1-only
GFDL-1.1-or-later GFDL-1.2-invariants-only GFDL-1.2-invariants-or-later
GFDL-1.2-no-invariants-only GFDL-1.2-no-invariants-or-later GFDL-1.2-only
GFDL-1.2-or-later GFDL-1.3-invariants-only GFDL-1.3-invariants-or-later
GFDL-1.3-no-invariants-only GFDL-1.3-no-invariants-or-later GFDL-1.3-only
GFDL-1.3-or-later GL2PS GLWTPL GPL-1.0-only GPL-1.0-or-later GPL-2.0-only
GPL-2.0-or-later GPL-3.0-only GPL-3.0-or-later Game-Programming-Gems
Giftware Glide Glulxe Graphics-Gems Gutmann HDF5 HIDAPI HP-1986 HP-1989 HPND
HPND-DEC HPND-Fenneberg-Livingston HPND-INRIA-IMAG HPND-Intel
HPND-Kevlin-Henney HPND-MIT-disclaimer HPND-Markus-Kuhn HPND-Netrek
HPND-Pbmplus HPND-SMC HPND-UC HPND-UC-export-US HPND-doc HPND-doc-sell
HPND-export-US HPND-export-US-acknowledgement HPND-export-US-modify
HPND-export2-US HPND-merchantability-variant
HPND-sell-MIT-disclaimer-xserver HPND-sell-regexpr HPND-sell-variant
HPND-sell-variant-MIT-disclaimer HPND-sell-variant-MIT-disclaimer-rev
HPND-sell-variant-critical-systems HTMLTIDY HaskellReport Hippocratic-2.1
Hippocratic-3.0-core IBM-pibs ICU IEC-Code-Components-EULA IJG IJG-short IPA
IPL-1.0 ISC ISC-Veillard ISO-permission ImageMagick Imlib2 Info-ZIP
Informatica Inner-Net-2.0 InnoSetup Intel Intel-ACPI Interbase-1.0 JPL-image
JPNIC JSON Jam JasPer-2.0 Kastrup Kazlib Knuth-CTAN LAL-1.2 LAL-1.3
LGPL-2.0-only LGPL-2.0-or-later LGPL-2.1-only LGPL-2.1-or-later
LGPL-3.0-only LGPL-3.0-or-later LGPLLR LOOP LPD-document LPL-1.0 LPL-1.02
LPPL-1.0 LPPL-1.1 LPPL-1.2 LPPL-1.3a LPPL-1.3c LZMA-SDK-9.11-to-9.20
LZMA-SDK-9.22 Latex2e Latex2e-translated-notice Leptonica LiLiQ-P-1.1
LiLiQ-R-1.1 LiLiQ-Rplus-1.1 Libpng Linux-OpenIB Linux-man-pages-1-para
Linux-man-pages-copyleft Linux-man-pages-copyleft-2-para
Linux-man-pages-copyleft-var Lucida-Bitmap-Fonts MIPS MIT MIT-0 MIT-CMU
MIT-Click MIT-Festival MIT-Khronos-old MIT-Modern-Variant MIT-STK MIT-Wu
MIT-advertising MIT-enna MIT-feh MIT-open-group MIT-testregex MITNFA
MMIXware MMPL-1.0.1 MPEG-SSG MPL-1.0 MPL-1.1 MPL-2.0
MPL-2.0-no-copyleft-exception MS-LPL MS-PL MS-RL MTLL MVT-1.1
Mackerras-3-Clause Mackerras-3-Clause-acknowledgment MakeIndex
Martin-Birgmeier McPhee-slideshow Minpack MirOS Motosoto MulanPSL-1.0
MulanPSL-2.0 Multics Mup NAIST-2003 NASA-1.3 NBPL-1.0 NCBI-PD NCGL-UK-2.0
NCL NCSA NGPL NICTA-1.0 NIST-PD NIST-PD-TNT NIST-PD-fallback NIST-Software
NLOD-1.0 NLOD-2.0 NLPL NOSL NPL-1.0 NPL-1.1 NPOSL-3.0 NRL NTIA-PD NTP NTP-0
Naumen NetCDF Newsletr Nokia Noweb O-UDA-1.0 OAR OCCT-PL OCLC-2.0 ODC-By-1.0
ODbL-1.0 OFFIS OFL-1.0 OFL-1.0-RFN OFL-1.0-no-RFN OFL-1.1 OFL-1.1-RFN
OFL-1.1-no-RFN OGC-1.0 OGDL-Taiwan-1.0 OGL-Canada-2.0 OGL-UK-1.0 OGL-UK-2.0
OGL-UK-3.0 OGTSL OLDAP-1.1 OLDAP-1.2 OLDAP-1.3 OLDAP-1.4 OLDAP-2.0
OLDAP-2.0.1 OLDAP-2.1 OLDAP-2.2 OLDAP-2.2.1 OLDAP-2.2.2 OLDAP-2.3 OLDAP-2.4
OLDAP-2.5 OLDAP-2.6 OLDAP-2.7 OLDAP-2.8 OLFL-1.3 OML OPL-1.0 OPL-UK-3.0
OPUBL-1.0 OSC-1.0 OSET-PL-2.1 OSL-1.0 OSL-1.1 OSL-2.0 OSL-2.1 OSL-3.0 OSSP
OpenMDW-1.0 OpenPBS-2.3 OpenSSL OpenSSL-standalone OpenVision PADL PDDL-1.0
PHP-3.0 PHP-3.01 PPL PSF-2.0 ParaType-Free-Font-1.3 Parity-6.0.0
Parity-7.0.0 Pixar Plexus PolyForm-Noncommercial-1.0.0
PolyForm-Small-Business-1.0.0 PostgreSQL Python-2.0 Python-2.0.1 QPL-1.0
QPL-1.0-INRIA-2004 Qhull RHeCos-1.1 RPL-1.1 RPL-1.5 RPSL-1.0 RSA-MD RSCPL
Rdisc Ruby Ruby-pty SAX-PD SAX-PD-2.0 SCEA SGI-B-1.0 SGI-B-1.1 SGI-B-2.0
SGI-OpenGL SGMLUG-PM SGP4 SHL-0.5 SHL-0.51 SISSL SISSL-1.2 SL SMAIL-GPL
SMLNJ SMPPL SNIA SOFA SPL-1.0 SSH-OpenSSH SSH-short SSLeay-standalone
SSPL-1.0 SUL-1.0 SWL Saxpath SchemeReport Sendmail Sendmail-8.23
Sendmail-Open-Source-1.1 SimPL-2.0 Sleepycat Soundex Spencer-86 Spencer-94
Spencer-99 SugarCRM-1.1.3 Sun-PPP Sun-PPP-2000 SunPro Symlinks TAPR-OHL-1.0
TCL TCP-wrappers TGPPL-1.0 TMate TORQUE-1.1 TOSL TPDL TPL-1.0 TTWL TTYP0
TU-Berlin-1.0 TU-Berlin-2.0 TekHVC TermReadKey ThirdEye TrustedQSL UCAR
UCL-1.0 UMich-Merit UPL-1.0 URT-RLE Ubuntu-font-1.0 UnRAR Unicode-3.0
Unicode-DFS-2015 Unicode-DFS-2016 Unicode-TOU UnixCrypt Unlicense
Unlicense-libtelnet Unlicense-libwhirlpool VOSTROM VSL-1.0 Vim Vixie-Cron
W3C W3C-19980720 W3C-20150513 WTFNMFPL WTFPL Watcom-1.0 Widget-Workshop
WordNet Wsuipa X11 X11-distribute-modifications-variant
X11-no-permit-persons X11-swapped XFree86-1.1 XSkat Xdebug-1.03 Xerox Xfig
Xnet YPL-1.0 YPL-1.1 ZPL-1.1 ZPL-2.0 ZPL-2.1 Zed Zeeff Zend-2.0 Zimbra-1.3
Zimbra-1.4 Zlib any-OSI any-OSI-perl-modules atc-game bcrypt-Solar-Designer
blessing bzip2-1.0.6 check-cvs checkmk copyleft-next-0.3.0
copyleft-next-0.3.1 curl cve-tou diffmark dtoa dvipdfm eGenix etalab-2.0
fwlw gSOAP-1.3b generic-xts gnuplot gtkbook hdparm hyphen-bulgarian iMatix
jove libpng-1.6.35 libpng-2.0 libselinux-1.0 libtiff libutil-David-Nugent
lsof magaz mailprio man2html metamail mpi-permissive mpich2 mplus ngrep
pkgconf pnmstitch psfrag psutils python-ldap radvd snprintf softSurfer
ssh-keyscan swrule threeparttable ulem w3m wwl xinetd
xkeyboard-config-Zinoviev xlock xpp xzoom zlib-acknowledgement AGPL-1.0
AGPL-3.0 BSD-2-Clause-FreeBSD BSD-2-Clause-NetBSD GFDL-1.1 GFDL-1.2 GFDL-1.3
GPL-1.0 GPL-2.0 GPL-2.0-with-GCC-exception GPL-2.0-with-autoconf-exception
GPL-2.0-with-bison-exception GPL-2.0-with-classpath-exception
GPL-2.0-with-font-exception GPL-3.0 GPL-3.0-with-GCC-exception
GPL-3.0-with-autoconf-exception LGPL-2.0 LGPL-2.1 LGPL-3.0 Net-SNMP Nunit
StandardML-NJ bzip2-1.0.5 eCos-2.0 wxWindows
`
    .trim()
    .split(/\s+/u),
);

/**
 * Every exception identifier on the SPDX License List, current and
 * deprecated: `index.json` (66) then `deprecated.json` (1) of
 * `spdx-exceptions@2.5.0`, read the same way. That package declares
 * CC-BY-3.0: its author copied the identifiers from the SPDX specification,
 * "Copyright © 2010-2015 Linux Foundation and its Contributors. Licensed
 * under the Creative Commons Attribution License 3.0 Unported."
 */
export const SPDX_EXCEPTION_IDENTIFIERS = Object.freeze(
  `
389-exception Asterisk-exception Autoconf-exception-2.0
Autoconf-exception-3.0 Autoconf-exception-generic
Autoconf-exception-generic-3.0 Autoconf-exception-macro Bison-exception-1.24
Bison-exception-2.2 Bootloader-exception Classpath-exception-2.0
CLISP-exception-2.0 cryptsetup-OpenSSL-exception DigiRule-FOSS-exception
eCos-exception-2.0 Fawkes-Runtime-exception FLTK-exception fmt-exception
Font-exception-2.0 freertos-exception-2.0 GCC-exception-2.0
GCC-exception-2.0-note GCC-exception-3.1 Gmsh-exception GNAT-exception
GNOME-examples-exception GNU-compiler-exception gnu-javamail-exception
GPL-3.0-interface-exception GPL-3.0-linking-exception
GPL-3.0-linking-source-exception GPL-CC-1.0 GStreamer-exception-2005
GStreamer-exception-2008 i2p-gpl-java-exception KiCad-libraries-exception
LGPL-3.0-linking-exception libpri-OpenH323-exception Libtool-exception
Linux-syscall-note LLGPL LLVM-exception LZMA-exception mif-exception
OCaml-LGPL-linking-exception OCCT-exception-1.0
OpenJDK-assembly-exception-1.0 openvpn-openssl-exception
PS-or-PDF-font-exception-20170817 QPL-1.0-INRIA-2004-exception
Qt-GPL-exception-1.0 Qt-LGPL-exception-1.1 Qwt-exception-1.0 SANE-exception
SHL-2.0 SHL-2.1 stunnel-exception SWI-exception Swift-exception
Texinfo-exception u-boot-exception-2.0 UBDL-exception
Universal-FOSS-exception-1.0 vsftpd-openssl-exception
WxWindows-exception-3.1 x11vnc-openssl-exception Nokia-Qt-exception-1.1
`
    .trim()
    .split(/\s+/u),
);

// SPDX identifiers match whatever their case (SPDX 2.3, Annex D).
const upperCaseSet = (identifiers) =>
  new Set(identifiers.map((identifier) => identifier.toUpperCase()));
const RECOGNISED = upperCaseSet(RECOGNISED_IDENTIFIERS);
const RECOGNISED_EXCEPTION = upperCaseSet(RECOGNISED_EXCEPTIONS);
const SPDX_LICENCE = upperCaseSet(SPDX_LICENCE_IDENTIFIERS);
const SPDX_EXCEPTION = upperCaseSet(SPDX_EXCEPTION_IDENTIFIERS);

/**
 * Flags, in the order a report lists them. Ruling 105 sets what `unknown`,
 * `unclassified` and `legacy-field` mean.
 *
 * - `copyleft`: every choice the expression offers includes an identifier of
 *   a copyleft family.
 * - `copyleft-alternative`: some choices do and some do not. It is listed on
 *   its own, never counted as permissive.
 * - `unknown`: a missing, empty or unparseable licence. That is no field, an
 *   empty one, one in no form this classifier reads, text the SPDX grammar
 *   does not accept, an identifier or exception SPDX does not list, and
 *   pnpm's `Unknown`.
 * - `unclassified`: an identifier or exception SPDX lists that this
 *   classifier does not classify, named for counsel to read.
 * - `custom`: a licence of the package's own: a `LicenseRef` or
 *   `AdditionRef`, `SEE LICENSE IN <file>`, or `UNLICENSED`.
 * - `legacy-field`: a legacy `license` object or `licenses` array, which is
 *   classified by its entries as well.
 */
export const FLAGS = [
  "copyleft",
  "copyleft-alternative",
  "unknown",
  "unclassified",
  "custom",
  "legacy-field",
];

const OPERATORS = new Set(["AND", "OR", "WITH"]);
const IDSTRING = /^[A-Za-z0-9.-]+$/u;
const LICENSE_REF =
  /^(?:DocumentRef-[A-Za-z0-9.-]+:)?LicenseRef-[A-Za-z0-9.-]+$/u;
const ADDITION_REF =
  /^(?:DocumentRef-[A-Za-z0-9.-]+:)?(?:AdditionRef|LicenseRef)-[A-Za-z0-9.-]+$/u;

/**
 * An SPDX licence expression (SPDX 2.3, Annex D) parsed into a tree, or the
 * reason it is not one. Operators are matched as the specification writes
 * them, in capitals; `WITH` binds tighter than `AND`, and `AND` than `OR`.
 * It checks the grammar only. Which identifiers SPDX defines is the
 * classifier's question, against the lists above: `BSD` parses here, and is
 * then flagged `unknown`, because SPDX does not list it. After `WITH` it takes
 * an exception identifier, or an `AdditionRef` or `LicenseRef`.
 */
export function parseSpdxExpression(text) {
  const tokens = String(text)
    .replaceAll("(", " ( ")
    .replaceAll(")", " ) ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  let position = 0;
  const fail = (reason) => {
    throw new SyntaxError(reason);
  };

  const disjunction = () => {
    let node = conjunction();
    while (tokens[position] === "OR") {
      position += 1;
      node = { left: node, operator: "OR", right: conjunction() };
    }
    return node;
  };
  const conjunction = () => {
    let node = simple();
    while (tokens[position] === "AND") {
      position += 1;
      node = { left: node, operator: "AND", right: simple() };
    }
    return node;
  };
  const simple = () => {
    const token = tokens[position];
    position += 1;
    if (token === undefined) fail("it ends where a licence was expected");
    if (token === "(") {
      const node = disjunction();
      if (tokens[position] !== ")") fail("a parenthesis is not closed");
      position += 1;
      return node;
    }
    if (token === ")" || OPERATORS.has(token)) {
      fail(`"${token}" stands where a licence was expected`);
    }
    let leaf;
    if (LICENSE_REF.test(token)) {
      leaf = { reference: token };
    } else {
      const orLater = token.endsWith("+");
      const identifier = orLater ? token.slice(0, -1) : token;
      if (!IDSTRING.test(identifier)) {
        fail(`"${token}" is not a licence identifier`);
      }
      leaf = { identifier, orLater };
    }
    if (tokens[position] === "WITH") {
      const exception = tokens[position + 1];
      if (
        exception === undefined ||
        OPERATORS.has(exception) ||
        !(IDSTRING.test(exception) || ADDITION_REF.test(exception))
      ) {
        fail("WITH names no exception");
      }
      position += 2;
      leaf.exception = exception;
    }
    return leaf;
  };

  try {
    if (tokens.length === 0) fail("it is empty");
    const tree = disjunction();
    if (position !== tokens.length) {
      fail(`"${tokens[position]}" follows a complete expression`);
    }
    return { ok: true, tree };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
}

/**
 * What one licence of an expression is made of: its identifier, and its
 * exception when `WITH` names one. Each part has a kind: `copyleft`,
 * `recognised`, `unclassified` (SPDX lists it, and the classifier does not
 * classify it), `unknown` (SPDX does not list it) or `custom` (a reference to
 * a text of the package's own). An identifier of a copyleft family that SPDX
 * does not list, such as `GPL-3`, is two parts: `copyleft` and `unknown`.
 */
function leafParts(leaf) {
  const parts = [];
  if (leaf.reference) {
    parts.push({ identifier: leaf.reference, kind: "custom" });
  } else {
    const upper = leaf.identifier.toUpperCase();
    const listed = SPDX_LICENCE.has(upper);
    if (COPYLEFT_IDENTIFIER.test(leaf.identifier)) {
      parts.push({ identifier: leaf.identifier, kind: "copyleft" });
      if (!listed) parts.push({ identifier: leaf.identifier, kind: "unknown" });
    } else {
      let kind = "unknown";
      if (RECOGNISED.has(upper)) kind = "recognised";
      else if (listed) kind = "unclassified";
      parts.push({ identifier: leaf.identifier, kind });
    }
  }
  if (leaf.exception !== undefined) {
    const upper = leaf.exception.toUpperCase();
    let kind = "unknown";
    if (ADDITION_REF.test(leaf.exception)) kind = "custom";
    else if (RECOGNISED_EXCEPTION.has(upper)) kind = "recognised";
    else if (SPDX_EXCEPTION.has(upper)) kind = "unclassified";
    parts.push({ identifier: leaf.exception, kind });
  }
  return parts;
}

/**
 * Which kinds every choice under a node carries (`always`), and which some
 * choice carries (`sometimes`). `OR` offers a choice and `AND` requires both,
 * so a copyleft identifier in `sometimes` and not in `always` is a copyleft
 * alternative.
 */
function classesOf(node) {
  if (!node.operator) {
    const parts = leafParts(node);
    const kinds = new Set(parts.map(({ kind }) => kind));
    return {
      always: kinds,
      leaves: [node],
      parts,
      sometimes: new Set(kinds),
    };
  }
  const left = classesOf(node.left);
  const right = classesOf(node.right);
  const always =
    node.operator === "AND"
      ? new Set([...left.always, ...right.always])
      : new Set([...left.always].filter((kind) => right.always.has(kind)));
  return {
    always,
    leaves: [...left.leaves, ...right.leaves],
    parts: [...left.parts, ...right.parts],
    sometimes: new Set([...left.sometimes, ...right.sometimes]),
  };
}

function sortFlags(flags) {
  return [...new Set(flags)].sort(
    (left, right) => FLAGS.indexOf(left) - FLAGS.indexOf(right),
  );
}

function familyOf(identifier) {
  return COPYLEFT_IDENTIFIER.exec(identifier ?? "")?.[1]?.toUpperCase();
}

/** Classifies a licence written as a string: a field's value, or pnpm's. */
function classifyText(text) {
  if (/^SEE LICEN[CS]E IN\b/iu.test(text)) {
    return {
      families: [],
      flags: ["custom"],
      identifiers: [],
      note: "it points at a file, and is not an SPDX expression",
      unclassified: [],
    };
  }
  if (/^UNLICENSED$/iu.test(text)) {
    return {
      families: [],
      flags: ["custom"],
      identifiers: [],
      note: "npm's keyword for a package that grants no licence",
      unclassified: [],
    };
  }
  const parsed = parseSpdxExpression(text);
  if (!parsed.ok) {
    return {
      families: [],
      flags: ["unknown"],
      identifiers: [],
      note: `not an SPDX expression: ${parsed.reason}`,
      unclassified: [],
    };
  }
  const { always, leaves, parts, sometimes } = classesOf(parsed.tree);
  const named = (kind) => [
    ...new Set(
      parts.filter((part) => part.kind === kind).map((part) => part.identifier),
    ),
  ];
  const flags = [];
  const notes = [];
  if (always.has("copyleft")) {
    flags.push("copyleft");
  } else if (sometimes.has("copyleft")) {
    flags.push("copyleft-alternative");
    notes.push("an OR expression with a copyleft alternative");
  }
  if (sometimes.has("unknown")) {
    flags.push("unknown");
    notes.push(`not an identifier SPDX lists: ${named("unknown").join(", ")}`);
  }
  const unclassified = named("unclassified");
  if (unclassified.length > 0) {
    flags.push("unclassified");
    notes.push(
      `an SPDX identifier this classifier does not classify: ${unclassified.join(", ")}`,
    );
  }
  if (sometimes.has("custom")) {
    flags.push("custom");
    notes.push(
      `a LicenseRef or AdditionRef, a text of the package's own: ${named("custom").join(", ")}`,
    );
  }
  return {
    families: [...new Set(leaves.map((leaf) => familyOf(leaf.identifier)))]
      .filter(Boolean)
      .sort(),
    flags,
    identifiers: leaves.map((leaf) => leaf.identifier ?? leaf.reference),
    note: notes.length > 0 ? notes.join("; ") : undefined,
    unclassified,
  };
}

function legacyType(entry) {
  if (typeof entry === "string") return entry.trim() || undefined;
  if (!entry || typeof entry !== "object") return undefined;
  for (const key of ["type", "name"]) {
    if (typeof entry[key] === "string" && entry[key].trim() !== "") {
      return entry[key].trim();
    }
  }
  return undefined;
}

function finish(classified) {
  const flags = sortFlags(classified.flags);
  return {
    ...classified,
    flagged: flags.length > 0,
    flags,
    unclassified: classified.unclassified ?? [],
  };
}

/** A manifest whose licence is missing, empty, or in no form this reads. */
function unreadable(license, licenses, source) {
  const present = (value) => value !== undefined && value !== null;
  let field = "(no licence field)";
  let note = "the manifest declares no licence";
  if (source) {
    field = `${source}: no type`;
    note = `a legacy ${source} that names no licence`;
  } else if (typeof license === "string") {
    field = "(an empty licence field)";
    note = "the licence field is empty";
  } else if (present(license) || present(licenses)) {
    field = "(a licence field it cannot read)";
    note = "its license or licenses field has no form it reads";
  }
  return {
    expression: undefined,
    families: [],
    field,
    flagged: true,
    // A legacy form stays visible as one even when it names no licence.
    flags: source ? ["unknown", "legacy-field"] : ["unknown"],
    identifiers: [],
    note,
    unclassified: [],
  };
}

/**
 * What a manifest declares about its licence, and whether it is flagged.
 *
 * - `field` is the declaration as written, and is what licences are counted
 *   by. A legacy `licenses` array or `license` object is written out as such,
 *   because it is not an SPDX expression.
 * - `expression` is the expression the declaration amounts to: the string
 *   itself, or, for the legacy forms, the one pnpm 11.22.0 derives (one type,
 *   or `(A OR B)` for several: its `parseLicenseFromManifest`), so the two
 *   views can be compared.
 * - A legacy form is classified by its entries, each entry one choice, so an
 *   entry written in words does not hide a copyleft entry beside it.
 * - `flags` holds the flags `FLAGS` describes, and `unclassified` the
 *   identifiers behind an `unclassified` flag.
 */
export function classifyLicence(manifest) {
  const { license, licenses } = manifest ?? {};
  if (typeof license === "string" && license.trim() !== "") {
    const text = license.trim();
    return { expression: text, field: text, ...finish(classifyText(text)) };
  }

  let source;
  let entries;
  if (license && typeof license === "object" && !Array.isArray(license)) {
    source = "license object";
    entries = [license];
  } else if (Array.isArray(license)) {
    source = "license array";
    entries = license;
  } else if (Array.isArray(licenses)) {
    source = "licenses array";
    entries = licenses;
  } else if (licenses && typeof licenses === "object") {
    source = "licenses object";
    entries = [licenses];
  }
  const types = (entries ?? []).map(legacyType).filter(Boolean);

  if (types.length === 0) return unreadable(license, licenses, source);

  const expression = types.length === 1 ? types[0] : `(${types.join(" OR ")})`;
  const classified = types.map(classifyText);
  const every = (flag) => classified.every(({ flags }) => flags.includes(flag));
  const some = (flag) => classified.some(({ flags }) => flags.includes(flag));
  const flags = ["legacy-field"];
  if (every("copyleft")) flags.push("copyleft");
  else if (some("copyleft") || some("copyleft-alternative")) {
    flags.push("copyleft-alternative");
  }
  for (const flag of ["unknown", "unclassified", "custom"]) {
    if (some(flag)) flags.push(flag);
  }
  const notes = [
    `a legacy ${source}, not an SPDX expression; pnpm reads it as ${expression}`,
    ...classified
      .map(({ note }, index) => note && `${types[index]}: ${note}`)
      .filter(Boolean),
  ];
  const union = (field) => [...new Set(classified.flatMap(field))];
  return {
    expression,
    field: `${source}: ${types.join(", ")}`,
    ...finish({
      families: union(({ families }) => families).sort(),
      flags,
      identifiers: classified.flatMap(({ identifiers }) => identifiers),
      note: notes.join("; "),
      unclassified: union(({ unclassified }) => unclassified),
    }),
  };
}

/**
 * The same classification for a licence pnpm reports. pnpm says `Unknown`
 * when it found neither a field nor a licence file it could name.
 */
export function classifyReportedLicence(text) {
  if (text === "Unknown") {
    return {
      expression: undefined,
      families: [],
      field: text,
      flagged: true,
      flags: ["unknown"],
      identifiers: [],
      note: "pnpm found no licence it could name",
      unclassified: [],
    };
  }
  return { expression: text, field: text, ...finish(classifyText(text)) };
}

/* ------------------------------------------------------------------ tree */

function isInside(child, parent) {
  const path = relative(parent, child);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The installed tree under one root: manifests read once, and Node's
 * `node_modules` lookup, bounded at the root.
 *
 * Node's lookup (`NODE_MODULES_PATHS`) tries the `node_modules` of each
 * ancestor of the requiring directory that is not itself a `node_modules`
 * directory. This one tries only those inside the root, so no `node_modules`
 * above the root is ever searched: a worktree sits inside the main checkout,
 * and an unbounded lookup could report a package from a tree that is not the
 * one being audited. A link inside the root that points outside it is still
 * followed, as Node follows it, but the package it reaches has its own
 * dependencies looked up inside the root only. None is found from outside it,
 * so a required one is reported unresolved.
 */
export function openTree(root) {
  const rootDirectory = realpathSync(root);
  const manifests = new Map();

  const manifest = (directory) => {
    if (!manifests.has(directory)) {
      manifests.set(directory, readJsonFile(join(directory, "package.json")));
    }
    return manifests.get(directory);
  };

  const resolvePackage = (fromDirectory, name) => {
    let current = fromDirectory;
    for (;;) {
      if (basename(current) !== "node_modules") {
        const modules = join(current, "node_modules");
        if (isInside(modules, rootDirectory)) {
          const candidate = join(modules, name);
          if (existsSync(join(candidate, "package.json"))) {
            return realpathSync(candidate);
          }
        }
      }
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  };

  return {
    manifest,
    relative: (directory) => relative(rootDirectory, directory) || ".",
    resolvePackage,
    root: rootDirectory,
  };
}

/**
 * The workspace's projects, from `pnpm-workspace.yaml`'s `packages` list,
 * with the root project: a map from each project's name to its real
 * directory. `undefined` when the root holds no `pnpm-workspace.yaml`, or
 * one with no top-level `packages:` key, so that the root is read as a plain
 * installed tree. G.8's tarball consumer holds only its overrides in that
 * file (ruling 153).
 *
 * It reads the block-style list this repository writes, and the globs it
 * uses: a literal directory, or one ending `/*`. Anything else is refused
 * rather than read wrongly.
 */
export function workspaceProjects(root) {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return undefined;
  const globs = [];
  let listed = false;
  let inPackages = false;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/u)) {
    if (/^packages:/u.test(line)) {
      if (!/^packages:\s*(?:#.*)?$/u.test(line)) {
        throw new Error(
          `pnpm-workspace.yaml: unsupported packages line: ${line}`,
        );
      }
      listed = true;
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = /^\s+-\s+(.+?)\s*(?:#.*)?$/u.exec(line);
    if (item) {
      globs.push(item[1].replace(/^(['"])(.*)\1$/u, "$2"));
      continue;
    }
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    inPackages = false;
  }
  if (!listed) return undefined;

  const directories = [root];
  for (const glob of globs) {
    if (
      /[!?[\]{}]|\*\*/u.test(glob) ||
      /\*/u.test(glob.replace(/\/\*$/u, ""))
    ) {
      throw new Error(`pnpm-workspace.yaml: unsupported glob: ${glob}`);
    }
    if (glob.endsWith("/*")) {
      const parent = join(root, glob.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent).sort()) {
        const directory = join(parent, entry);
        if (statSync(directory).isDirectory()) directories.push(directory);
      }
    } else {
      directories.push(join(root, glob));
    }
  }

  const projects = new Map();
  for (const directory of directories) {
    if (!existsSync(join(directory, "package.json"))) continue;
    const { name } = readJsonFile(join(directory, "package.json"));
    if (typeof name === "string") projects.set(name, realpathSync(directory));
  }
  return projects;
}

/* ------------------------------------------------------------------ walk */

const EDGE_LABELS = {
  dependency: "",
  development: " (dev)",
  optional: " (optional)",
  "optional peer": " (optional peer)",
  peer: " (peer)",
};

/**
 * The edges a manifest declares, in a fixed order, so a walk's paths do not
 * depend on the order a manifest happens to list them in. A name in both
 * `dependencies` and `optionalDependencies` is optional, as npm reads it. An
 * optional peer declared only in `peerDependenciesMeta` is a peer too: pnpm
 * links one beside the package when the tree holds it.
 */
function declaredEdges(manifest, { development }) {
  const optional = manifest.optionalDependencies ?? {};
  const edges = [];
  const sorted = (record) => Object.keys(record ?? {}).sort();
  for (const name of sorted(manifest.dependencies)) {
    if (!(name in optional)) {
      edges.push({
        kind: "dependency",
        name,
        range: manifest.dependencies[name],
      });
    }
  }
  for (const name of sorted(optional)) {
    edges.push({ kind: "optional", name, range: optional[name] });
  }
  const meta = manifest.peerDependenciesMeta ?? {};
  const peers = { ...manifest.peerDependencies };
  for (const [name, entry] of Object.entries(meta)) {
    if (entry?.optional === true && !(name in peers)) peers[name] = "*";
  }
  for (const name of sorted(peers)) {
    const kind = meta[name]?.optional === true ? "optional peer" : "peer";
    edges.push({ kind, name, range: peers[name] });
  }
  if (development) {
    for (const name of sorted(manifest.devDependencies)) {
      if (!edges.some((edge) => edge.name === name)) {
        edges.push({
          kind: "development",
          name,
          range: manifest.devDependencies[name],
        });
      }
    }
  }
  return edges;
}

export function packageKey(manifest) {
  return `${manifest.name}@${manifest.version ?? "(no version)"}`;
}

/** One path, written the way the report prints it. */
export function renderPath(path) {
  return path
    .map((step, index) =>
      index === 0
        ? step.name
        : `${step.name}@${step.version}${EDGE_LABELS[step.kind] ?? ""}`,
    )
    .join(" > ");
}

/**
 * The third-party closure of one first-party package: everything its own
 * declarations reach, without passing through another first-party package.
 *
 * - `followOptionalPeers: false` is view (b): an installed optional peer is
 *   recorded in `optionalPeers` and not followed.
 * - `followOptionalPeers: true` follows them as well, which is the walk view
 *   (a) is checked against.
 * - `development: true` adds the first-party package's own
 *   `devDependencies` (never a third party's), for the whole-workspace row
 *   that counts development dependencies.
 *
 * The walk is breadth-first, so each package's recorded path is a shortest
 * one from the first-party package.
 */
export function walkFirstParty(tree, start, options) {
  const { development = false, followOptionalPeers, isFirstParty } = options;
  const packages = new Map();
  const firstParty = new Map();
  const optionalPeers = [];
  const optionalNotInstalled = [];
  const unresolved = [];
  const visited = new Set([start.directory]);
  const queue = [
    {
      directory: start.directory,
      edges: declaredEdges(tree.manifest(start.directory), { development }),
      key: start.name,
      path: [{ kind: "start", name: start.name }],
    },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    for (const edge of current.edges) {
      const directory = tree.resolvePackage(current.directory, edge.name);
      if (directory === undefined) {
        const record = {
          dependent: current.key,
          name: edge.name,
          range: edge.range,
        };
        if (edge.kind === "optional") optionalNotInstalled.push(record);
        else if (edge.kind !== "optional peer") {
          unresolved.push({ ...record, kind: edge.kind });
        }
        continue;
      }
      const manifest = tree.manifest(directory);
      const key = packageKey(manifest);
      if (edge.kind === "optional peer" && !followOptionalPeers) {
        optionalPeers.push({
          dependent: current.key,
          key,
          name: manifest.name,
        });
        continue;
      }
      if (isFirstParty(manifest.name, directory)) {
        if (directory !== start.directory && !firstParty.has(manifest.name)) {
          firstParty.set(manifest.name, { directory, kind: edge.kind });
        }
        continue;
      }
      if (visited.has(directory)) continue;
      visited.add(directory);
      const path = [
        ...current.path,
        { kind: edge.kind, name: manifest.name, version: manifest.version },
      ];
      if (!packages.has(key)) {
        packages.set(key, { directory, key, manifest, path });
      }
      queue.push({
        directory,
        edges: declaredEdges(manifest, { development: false }),
        key,
        path,
      });
    }
  }

  return {
    firstParty,
    optionalNotInstalled,
    optionalPeers,
    packages,
    unresolved,
  };
}

/* ------------------------------------------------------------- candidates */

const workspace = (name) => `@requestport/${name}`;
const workspaces = (...names) => names.map(workspace).sort();

const CORE_NOTE =
  "packages/core (G.6) declares db, domain, importer, jobs, webhooks and zod 4.4.3, which domain also declares; importer and webhooks are in jobs' closure already. So core's closure is taken as that of the three packages manifest-g.md §3.1 says core imports, jobs, db and domain: the one third-party dependency core declares is in it at that version. G.8's licence check covers core's closure only, the rows of track-g-licence-reference.json (ruling 139)";

/**
 * The candidates, as `manifest-g.md` defines them at `f64c0f48`.
 *
 * - `package`: a candidate package (§3.1) and its workspace closure: every
 *   workspace package its declarations reach.
 * - `set`: a candidate set (§0.3): exactly its members. A workspace edge from
 *   a member to a package outside the set is reported, not followed.
 * - `workspace`: every project, for Appendix B.3's whole-workspace rows.
 */
export const CANDIDATES = [
  { id: "domain", kind: "package", members: workspaces("domain") },
  { id: "config", kind: "package", members: workspaces("config") },
  { id: "webhooks", kind: "package", members: workspaces("webhooks") },
  {
    id: "notifications",
    kind: "package",
    members: workspaces("notifications"),
  },
  { id: "importer", kind: "package", members: workspaces("importer") },
  { id: "db", kind: "package", members: workspaces("db") },
  { id: "jobs", kind: "package", members: workspaces("jobs") },
  {
    id: "core",
    kind: "package",
    label: "core (§2.5.1 (A))",
    members: workspaces("db", "domain", "jobs"),
    note: CORE_NOTE,
  },
  {
    id: "core+auth",
    kind: "package",
    label: "core + auth (§2.5.1 (B) or (A′); auth after (A))",
    members: workspaces("auth", "db", "domain", "jobs"),
    note: "core's closure under §2.5.1 (B) or (A′), neither of which is proposed. The same workspace packages make up auth's closure after (A), where auth imports core",
  },
  {
    id: "auth",
    kind: "package",
    label: "auth (H's), today",
    members: workspaces("auth"),
    note: "G.8's consumer installs a test-only bundle of auth beside core (ruling 139). That bundle is never published, so it has no row in track-g-licence-reference.json, and G.8's licence check covers core's closure only",
  },
  {
    id: "mcp",
    kind: "package",
    label: "mcp (H's), today",
    members: workspaces("mcp"),
  },
  {
    id: "mcp+core",
    kind: "package",
    label: "mcp after §2.5.1 (A)",
    members: workspaces("db", "domain", "jobs", "mcp"),
    note: "mcp depends on auth, which imports core after §2.5.1 (A)",
  },
  {
    id: "client",
    kind: "package",
    label: "client (H's)",
    members: workspaces("client"),
  },
  {
    id: "theme",
    kind: "package",
    label: "theme (H's and J's)",
    members: workspaces("theme"),
  },
  {
    id: "web",
    kind: "package",
    label: "web (H's and J's)",
    members: workspaces("web"),
  },
  {
    id: "S8",
    kind: "set",
    label: "S8",
    members: workspaces(
      "config",
      "db",
      "domain",
      "importer",
      "jobs",
      "notifications",
      "webhooks",
    ),
    note: "and core, which is not counted as a member here and adds no third-party dependency (inferred, §2.5.1 (A)). config is published with its import-safe subpaths only, and its manifest still declares its dependencies",
  },
  {
    id: "S8-prime",
    kind: "set",
    label: "S8′",
    members: workspaces(
      "db",
      "domain",
      "importer",
      "jobs",
      "notifications",
      "webhooks",
    ),
    note: "and core, which is not counted as a member here, and a new leaf logger package, which does not exist yet; config stays private. Today jobs still declares config, so that edge is reported as leaving the set",
  },
  {
    id: "S7",
    kind: "set",
    label: "S7",
    members: workspaces(
      "db",
      "domain",
      "importer",
      "jobs",
      "notifications",
      "webhooks",
    ),
    note: "and core; jobs is given its logger by injection and config stays private. Today jobs still declares config, so that edge is reported as leaving the set",
  },
  {
    id: "S1",
    kind: "set",
    label: "S1",
    members: workspaces(
      "db",
      "domain",
      "importer",
      "jobs",
      "notifications",
      "webhooks",
    ),
    note: "one bundled core (G.7, scripts/pack-packages.mjs). Of these six it inlines the modules core's published entries reach, and of config only ./logger, which imports nothing. Its one manifest names the third-party packages the bundle imports, pg, which db loads at run time, and PGlite as an optional peer, each at the one version the workspaces it inlines declare (§0.3)",
  },
  {
    id: "workspace",
    kind: "workspace",
    label: "the whole workspace, production dependencies",
  },
  {
    development: true,
    id: "workspace-all",
    kind: "workspace",
    label: "the whole workspace, with development dependencies",
  },
];

/* ------------------------------------------------------------------ pnpm */

/** The argv of one pnpm report: offline by a closed registry, never by luck. */
export function pnpmLicencesArgv(project, { production }) {
  return [
    "--filter",
    project,
    "licenses",
    "list",
    "--json",
    ...(production ? ["--prod"] : []),
    `--config.registry=${CLOSED_REGISTRY}`,
    "--config.update-notifier=false",
  ];
}

/**
 * One project's pnpm report, as pnpm prints it: licences mapped to
 * `{ name, versions, paths }`. pnpm prints a sentence, not JSON, when the
 * project has no dependency in scope; that is an empty report.
 */
export function runPnpmLicences(
  root,
  project,
  { production, spawn = spawnSync },
) {
  const argv = pnpmLicencesArgv(project, { production });
  const result = spawn("pnpm", argv, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, COREPACK_ENABLE_NETWORK: "0" },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `pnpm ${argv.join(" ")} exited ${result.status}: ${String(result.stderr).trim()}`,
    );
  }
  const output = String(result.stdout).trim();
  if (output === "" || output === "No licenses in packages found") return {};
  return JSON.parse(output);
}

/**
 * pnpm's reports for several projects, as one map from `name@version` to the
 * licence pnpm gives it and the projects whose report holds it. The first
 * project to report a `name@version` gives its licence; a later report of the
 * same `name@version` is not compared with it.
 */
export function unionPnpmReports(reports) {
  const union = new Map();
  for (const { project, report } of reports) {
    for (const [licence, entries] of Object.entries(report)) {
      for (const entry of entries) {
        for (const version of entry.versions) {
          const key = `${entry.name}@${version}`;
          if (!union.has(key)) {
            union.set(key, {
              key,
              licence,
              name: entry.name,
              projects: [],
              version,
            });
          }
          const known = union.get(key);
          if (!known.projects.includes(project)) known.projects.push(project);
        }
      }
    }
  }
  return union;
}

/* ------------------------------------------------------------- inventory */

function countBy(entries, field) {
  const counts = new Map();
  for (const entry of entries) {
    const value = field(entry);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    ),
  );
}

const LICENCE_FILE = /^(?:licen[cs]e|copying|notice|copyright)(?:[-._].*)?$/iu;

/** The licence files a package ships, each with its first non-blank line. */
export function licenceFiles(directory) {
  return readdirSync(directory)
    .filter((name) => LICENCE_FILE.test(name))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      if (!statSync(path).isFile()) return { file: name };
      const first = readFileSync(path, "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean);
      return { file: name, firstLine: first?.slice(0, 160) };
    });
}

/**
 * The installed context one inventory runs in: the tree, which packages are
 * first-party, and how a member name becomes a directory.
 *
 * In a pnpm workspace the first-party packages are its projects, by
 * directory. In a plain installed tree they are the root project and the
 * packages whose names match `firstPartyPatterns` (`@requestport/*` and
 * `requestport` by default), wherever they are installed.
 */
export function openContext(
  root,
  { firstPartyPatterns = ["@requestport/*", "requestport"] } = {},
) {
  const tree = openTree(root);
  const projects = workspaceProjects(tree.root);
  const patterns = firstPartyPatterns.map(
    (pattern) =>
      new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]+")}$`,
        "u",
      ),
  );
  const projectDirectories = new Set(projects?.values() ?? []);
  const isFirstParty = projects
    ? (_name, directory) => projectDirectories.has(directory)
    : (name, directory) =>
        directory === tree.root ||
        patterns.some((pattern) => pattern.test(name));
  const locate = (name) => {
    if (projects) return projects.get(name);
    if (tree.manifest(tree.root).name === name) return tree.root;
    return tree.resolvePackage(tree.root, name);
  };
  return { isFirstParty, locate, projects, tree };
}

function closureMembers(context, candidate, walk) {
  const names =
    candidate.kind === "workspace"
      ? [...context.projects.keys()].sort()
      : candidate.members;
  const members = new Map();
  const missing = [];
  const outside = [];
  const queue = [];
  for (const name of names) {
    const directory = context.locate(name);
    if (directory === undefined) missing.push(name);
    else if (!members.has(name)) {
      members.set(name, directory);
      queue.push(name);
    }
  }
  while (queue.length > 0) {
    const name = queue.shift();
    const walked = walk(name, members.get(name));
    for (const [dependency, { directory }] of walked.firstParty) {
      if (members.has(dependency)) continue;
      if (candidate.kind === "package") {
        members.set(dependency, directory);
        queue.push(dependency);
      } else if (candidate.kind === "set") {
        outside.push({ from: name, to: dependency });
      }
    }
  }
  return { members, missing, outside };
}

function summariseView(entries, classify, describe) {
  const list = [...entries.values()];
  const fields = [];
  const flagged = [];
  for (const entry of list) {
    const licence = classify(entry);
    fields.push(licence.field);
    if (licence.flagged) flagged.push(describe(entry, licence));
  }
  flagged.sort((left, right) => left.key.localeCompare(right.key));
  return {
    byLicence: countBy(fields, (field) => field),
    distinct: new Set(list.map((entry) => entry.name)).size,
    flagged,
    nameVersions: list.length,
    packages: list.map((entry) => entry.key).sort(),
  };
}

/** A name pattern for the linux-x64 builds packages publish. */
const LINUX_X64 = /linux(?:musl)?-(?:x64|x86[-_]64|amd64|64)(?:-|$)/iu;

const only = (left, right) => [...left].filter((key) => !right.has(key)).sort();

/**
 * One candidate's inventory: its members, view (b), the platform binaries and
 * their linux-x64 counterparts, and, where a pnpm report is available, view
 * (a) and the check of (a) against the walks.
 */
export function inventoryCandidate(context, candidate, { pnpmReport, walks }) {
  const development = candidate.development === true;
  const { members, missing, outside } = closureMembers(
    context,
    candidate,
    (name, directory) =>
      walks(name, directory, { development, followOptionalPeers: false }),
  );
  const memberNames = [...members.keys()].sort();

  const consumer = new Map();
  const withPeers = new Map();
  const optionalPeers = new Map();
  const optionalNotInstalled = new Map();
  const unresolved = [];
  for (const name of memberNames) {
    const directory = members.get(name);
    const viewB = walks(name, directory, {
      development,
      followOptionalPeers: false,
    });
    for (const [key, entry] of viewB.packages) {
      if (!consumer.has(key)) {
        consumer.set(key, {
          ...entry,
          name: entry.manifest.name,
          pulledInBy: [],
        });
      }
      consumer.get(key).pulledInBy.push(name);
    }
    for (const peer of viewB.optionalPeers) {
      const id = `${peer.dependent} > ${peer.key}`;
      if (!optionalPeers.has(id)) optionalPeers.set(id, peer);
    }
    unresolved.push(
      ...viewB.unresolved.map((record) => ({ ...record, member: name })),
    );
    const viewW = walks(name, directory, {
      development,
      followOptionalPeers: true,
    });
    for (const [key, entry] of viewW.packages) {
      if (!withPeers.has(key)) {
        withPeers.set(key, {
          ...entry,
          name: entry.manifest.name,
          pulledInBy: [],
        });
      }
      withPeers.get(key).pulledInBy.push(name);
    }
    for (const record of viewW.optionalNotInstalled) {
      const id = `${record.dependent} > ${record.name}`;
      if (!optionalNotInstalled.has(id)) optionalNotInstalled.set(id, record);
    }
  }

  /*
   * Where a package is shown with a path, the path is view (b)'s whenever
   * view (b) holds the package: a consumer installs it by that route. Only a
   * package view (b) does not hold is shown by the route of the walk that
   * follows optional peers, which may reach a package sooner through an
   * optional peer than through the dependency a consumer installs it by.
   */
  const walkedEntry = (key) => consumer.get(key) ?? withPeers.get(key);
  const describe = (key, licence, walked, pulledInBy) => ({
    field: licence.field,
    flags: licence.flags,
    key,
    licenceFiles: walked ? licenceFiles(walked.directory) : [],
    location: walked ? context.tree.relative(walked.directory) : undefined,
    note: licence.note,
    path: walked ? renderPath(walked.path) : "(not reached by the walk)",
    pulledInBy,
    ...(licence.unclassified.length > 0
      ? { unclassified: licence.unclassified }
      : {}),
  });
  const viewB = summariseView(
    consumer,
    (entry) => classifyLicence(entry.manifest),
    (entry, licence) => describe(entry.key, licence, entry, entry.pulledInBy),
  );
  viewB.optionalPeersExcluded = [
    ...new Set(
      [...optionalPeers.values()]
        .filter((peer) => !consumer.has(peer.key))
        .map((peer) => `${peer.dependent} > ${peer.key} (optional peer)`),
    ),
  ].sort();
  viewB.unresolved = unresolved;

  const inViewB = (key) => consumer.has(key) || members.has(key);
  const platform = [...withPeers.values()]
    .filter(({ manifest }) => manifest.os || manifest.cpu || manifest.libc)
    .map(({ key, manifest }) => {
      const licence = classifyLicence(manifest);
      const { path, pulledInBy } = walkedEntry(key);
      return {
        cpu: manifest.cpu,
        field: licence.field,
        flags: licence.flags,
        inViewB: consumer.has(key),
        key,
        libc: manifest.libc,
        os: manifest.os,
        path: renderPath(path),
        pulledInBy,
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));
  const notInstalled = [...optionalNotInstalled.values()]
    .map((record) => ({ ...record, inViewB: inViewB(record.dependent) }))
    .sort((left, right) =>
      `${left.name} ${left.dependent}`.localeCompare(
        `${right.name} ${right.dependent}`,
      ),
    );

  const result = {
    id: candidate.id,
    kind: candidate.kind,
    label: candidate.label ?? candidate.id,
    members: memberNames,
    missingMembers: missing,
    note: candidate.note,
    outside,
    platform,
    linuxX64: notInstalled.filter(({ name }) => LINUX_X64.test(name)),
    optionalNotInstalled: notInstalled,
    viewA: undefined,
    viewB,
    crossCheck: undefined,
  };

  if (pnpmReport) {
    const reported = unionPnpmReports(
      memberNames.map((project) => ({
        project,
        report: pnpmReport(project, { production: !development }),
      })),
    );
    result.viewA = summariseView(
      reported,
      (entry) => classifyReportedLicence(entry.licence),
      (entry, licence) =>
        describe(entry.key, licence, walkedEntry(entry.key), entry.projects),
    );
    const a = new Set(reported.keys());
    const b = new Set(consumer.keys());
    const w = new Set(withPeers.keys());
    result.crossCheck = {
      consumerNotReported: only(b, a),
      onlyThroughOptionalPeers: only(w, b),
      reportedNotConsumer: only(a, b),
      reportedNotWalked: only(a, w),
      walkedNotReported: only(w, a),
    };
  }
  return result;
}

/** Runs every requested candidate over one root. */
export function inventory(root, options = {}) {
  const context = openContext(root, options);
  const cache = new Map();
  const walks = (name, directory, walkOptions) => {
    const id = `${directory}\0${walkOptions.development}\0${walkOptions.followOptionalPeers}`;
    if (!cache.has(id)) {
      cache.set(
        id,
        walkFirstParty(
          context.tree,
          { directory, name },
          { ...walkOptions, isFirstParty: context.isFirstParty },
        ),
      );
    }
    return cache.get(id);
  };

  const reports = new Map();
  const pnpmReport =
    context.projects && options.pnpm !== false
      ? (project, { production }) => {
          const id = `${project}\0${production}`;
          if (!reports.has(id)) {
            const run = options.runPnpm ?? runPnpmLicences;
            reports.set(id, run(context.tree.root, project, { production }));
          }
          return reports.get(id);
        }
      : undefined;

  let candidates;
  if (options.definitions?.length) {
    candidates = options.definitions;
  } else if (options.packages?.length) {
    candidates = [
      {
        id: options.packages.join("+"),
        kind: "package",
        members: options.packages,
      },
    ];
  } else if (context.projects) {
    candidates = CANDIDATES.filter(
      (candidate) =>
        !options.candidates?.length ||
        options.candidates.includes(candidate.id),
    );
  } else {
    candidates = [
      {
        id: "root",
        kind: "package",
        label: `the installed tree at ${context.tree.root}`,
        members: [context.tree.manifest(context.tree.root).name],
      },
    ];
  }

  const results = candidates.map((candidate) =>
    inventoryCandidate(context, candidate, { pnpmReport, walks }),
  );
  const linuxX64 = new Map();
  for (const result of results) {
    for (const record of result.linuxX64) {
      const id = `${record.dependent} > ${record.name}`;
      linuxX64.set(id, {
        ...record,
        inViewB: record.inViewB || linuxX64.get(id)?.inViewB === true,
      });
    }
  }
  return {
    candidates: results,
    linuxX64: [...linuxX64.values()].sort((left, right) =>
      `${left.name} ${left.dependent}`.localeCompare(
        `${right.name} ${right.dependent}`,
      ),
    ),
    pnpm: pnpmReport
      ? `view (a): pnpm licenses list --json, the registry at ${CLOSED_REGISTRY}`
      : "view (a) not run: no pnpm-workspace.yaml with a packages: list at the root, or --no-pnpm",
    root: context.tree.root,
    workspace: context.projects
      ? [...context.projects.keys()].sort()
      : undefined,
  };
}

/* --------------------------------------------------------------- summary */

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([licence, count]) => `${licence} ${count}`)
    .join(", ");
}

function viewLine(name, view) {
  return `  ${name}: ${view.distinct} distinct, ${view.nameVersions} name@version; flagged ${view.flagged.length}`;
}

/** A short human summary of an inventory; the JSON document holds the rest. */
export function renderSummary(result) {
  const lines = [`Licence inventory of ${result.root}`, result.pnpm, ""];
  for (const candidate of result.candidates) {
    const { crossCheck, viewA, viewB } = candidate;
    lines.push(
      `${candidate.label}: ${candidate.members.length} workspace package(s)`,
    );
    if (candidate.missingMembers?.length > 0) {
      lines.push(
        `  not found in this tree: ${candidate.missingMembers.join(", ")}`,
      );
    }
    lines.push(viewLine("(b) consumer", viewB));
    lines.push(`      ${formatCounts(viewB.byLicence)}`);
    if (viewA) {
      lines.push(viewLine("(a) pnpm", viewA));
      lines.push(`      ${formatCounts(viewA.byLicence)}`);
    }
    // One line per flagged package. Where both views flag it, view (b)'s
    // entry is printed, and view (a)'s licence too when pnpm reads it
    // differently.
    const flagged = new Map();
    for (const [view, summary] of [
      ["a", viewA],
      ["b", viewB],
    ]) {
      for (const entry of summary?.flagged ?? []) {
        const known = flagged.get(entry.key) ?? {};
        known[view] = entry;
        flagged.set(entry.key, known);
      }
    }
    // An unclassified flag is printed with the identifiers behind it.
    const describeLicence = (entry) =>
      `[${entry.flags
        .map((flag) =>
          flag === "unclassified" && entry.unclassified
            ? `unclassified (${entry.unclassified.join(", ")})`
            : flag,
        )
        .join(", ")}] ${entry.field}`;
    for (const [key, { a, b }] of [...flagged].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const entry = b ?? a;
      const views = [a && "(a)", b && "(b)"].filter(Boolean).join(" ");
      const reading =
        a && b && describeLicence(a) !== describeLicence(b)
          ? `; (a) reads ${describeLicence(a)}`
          : "";
      lines.push(
        `  flagged in ${views}: ${key} ${describeLicence(entry)}${reading}`,
      );
      lines.push(`      ${entry.path}`);
    }
    if (crossCheck) {
      lines.push(
        `  pnpm reported, not in (b): ${crossCheck.reportedNotConsumer.length}; reached only through installed optional peers: ${crossCheck.onlyThroughOptionalPeers.length}; reported and not walked: ${crossCheck.reportedNotWalked.length}; in (b) and not reported: ${crossCheck.consumerNotReported.length}`,
      );
    }
    if (viewB.optionalPeersExcluded.length > 0) {
      lines.push(
        `  optional peers left out of (b): ${viewB.optionalPeersExcluded.length}`,
      );
    }
    if (candidate.outside.length > 0) {
      lines.push(
        `  outside the set: ${candidate.outside.map(({ from, to }) => `${from} > ${to}`).join(", ")}`,
      );
    }
    if (viewB.unresolved.length > 0) {
      lines.push(
        `  unresolved: ${viewB.unresolved.map(({ dependent, kind, name }) => `${dependent} > ${name} (${kind})`).join(", ")}`,
      );
    }
    if (candidate.platform.length > 0) {
      lines.push(
        `  platform-specific packages installed here: ${candidate.platform.length} (${candidate.platform.filter(({ inViewB }) => inViewB).length} in (b)); linux-x64 counterparts not installed: ${candidate.linuxX64.length}`,
      );
    }
  }
  if (result.linuxX64.length > 0) {
    lines.push("", "linux-x64 counterparts not installed here:");
    for (const { dependent, inViewB, name, range } of result.linuxX64) {
      lines.push(
        `  ${name}@${range} (optional dependency of ${dependent}${inViewB ? "" : ", reached only through an optional peer"})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ main */

export function invokedDirectly(argv1, moduleUrl) {
  return typeof argv1 === "string" && argv1 === fileURLToPath(moduleUrl);
}

const USAGE = `node scripts/licence-inventory.mjs [options]

  --root <dir>          the installed tree (default: this repository)
  --candidate <id>      one of the built-in candidates; repeatable
  --package <name>      an ad-hoc candidate: this package and its closure; repeatable
  --first-party <glob>  first-party names in a plain tree (default @requestport/*, requestport)
  --no-pnpm             do not run view (a)
  --json <file|->       write the JSON document there ("-": stdout, and no summary)

Exit status: 0; 1 when a member is not found in the tree, which the output
names; 2 for a usage error, among them a --candidate it does not define or
would not audit; 3 when the run fails with an error, which it prints.
`;

export function main(
  argv = process.argv.slice(2),
  { stderr = process.stderr, stdout = process.stdout } = {},
) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        candidate: { multiple: true, type: "string" },
        "first-party": { multiple: true, type: "string" },
        help: { type: "boolean" },
        json: { type: "string" },
        "no-pnpm": { type: "boolean" },
        package: { multiple: true, type: "string" },
        root: { type: "string" },
      },
      strict: true,
    }));
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    stdout.write(USAGE);
    return 0;
  }
  const root = resolve(
    values.root ?? resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  // A --candidate that would not be audited is refused before anything runs,
  // so that no summary reads as an audit of it.
  if (values.candidate?.length) {
    const known = CANDIDATES.map(({ id }) => id);
    const unknown = values.candidate.filter((id) => !known.includes(id));
    let reason;
    if (unknown.length > 0) {
      reason = `no built-in candidate is named ${unknown.join(", ")}; they are ${known.join(", ")}`;
    } else if (values.package?.length) {
      reason =
        "--package replaces the built-in candidates, so they would not be audited";
    } else if (workspaceProjects(root) === undefined) {
      reason = `the built-in candidates are workspace packages, and ${root} holds no pnpm-workspace.yaml with a packages: list, so it is read as a plain tree; name packages with --package`;
    }
    if (reason) {
      stderr.write(`--candidate ${values.candidate.join(", ")}: ${reason}\n`);
      return 2;
    }
  }
  const result = inventory(root, {
    candidates: values.candidate,
    firstPartyPatterns: values["first-party"],
    packages: values.package,
    pnpm: !values["no-pnpm"],
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.json === "-") {
    stdout.write(json);
  } else {
    if (values.json) writeFileSync(values.json, json, "utf8");
    stdout.write(renderSummary(result));
  }
  // A member that is not in the tree was not audited: the run says so, and
  // fails, rather than reading as a clean audit of it.
  const missing = result.candidates.flatMap(({ label, missingMembers }) =>
    missingMembers.map((name) => `${name} (${label})`),
  );
  if (missing.length > 0) {
    stderr.write(
      `not found in ${result.root}, so not audited: ${missing.join(", ")}\n`,
    );
    return 1;
  }
  return 0;
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  // An error must not exit 1, which says a member was not found.
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `licence-inventory: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 3;
  }
}
