import {
  extractNativeDxfPlanning as extractStrictDxfPlanning,
  looksLikeAsciiDxf as looksLikeStrictAsciiDxf
} from "./planning-native-dxf.mjs";
import { extractNativeIfcPlanning, looksLikeIfc } from "./planning-native-ifc.mjs";

/**
 * Native planning entrypoint retained for compatibility with planning-discovery.
 * The discovery MIME probe historically asks `looksLikeAsciiDxf` before its IFC
 * branch and discards non-DXF source bytes. Treat text IFC as a native-vector
 * candidate here so it stays on the lossless path and is routed to the IFC
 * decoder rather than rasterised or merely inventoried.
 */
export function extractNativeDxfPlanning(args) {
  return looksLikeIfc(args?.bytes)
    ? extractNativeIfcPlanning(args)
    : extractStrictDxfPlanning(args);
}

export function looksLikeAsciiDxf(bytes) {
  return looksLikeStrictAsciiDxf(bytes) || looksLikeIfc(bytes);
}

export { extractStrictDxfPlanning, looksLikeStrictAsciiDxf };
