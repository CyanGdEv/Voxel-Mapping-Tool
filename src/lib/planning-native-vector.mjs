import {
  extractNativeDxfPlanning as extractStrictDxfPlanning,
  looksLikeAsciiDxf as looksLikeStrictAsciiDxf
} from "./planning-native-dxf.mjs";
import { extractNativeIfcPlanning, looksLikeIfc } from "./planning-native-ifc.mjs";
import { extractNativeDwgPlanning, looksLikeDwg } from "./planning-native-dwg.mjs";

/**
 * Compatibility entrypoint used by planning-discovery. Native IFC and DWG are
 * deliberately recognized here as well as strict ASCII DXF so discovery keeps
 * their source bytes on the lossless native-document path. Each format is then
 * routed to its own conservative decoder.
 */
export function extractNativeDxfPlanning(args) {
  if (looksLikeIfc(args?.bytes)) return extractNativeIfcPlanning(args);
  if (looksLikeDwg(args?.bytes)) return extractNativeDwgPlanning(args);
  return extractStrictDxfPlanning(args);
}

export function looksLikeAsciiDxf(bytes) {
  return looksLikeStrictAsciiDxf(bytes) || looksLikeIfc(bytes) || looksLikeDwg(bytes);
}

export {
  extractStrictDxfPlanning,
  looksLikeStrictAsciiDxf,
  extractNativeDwgPlanning,
  looksLikeDwg
};
