/**
 * A local barrel that re-exports a CUE++ component under a name of its own.
 *
 * The tag a consumer writes then resolves into the installed package while the
 * consumer's own import specifier is local — which is exactly the shape that
 * made a name-of-the-import map miss, report a documented component as
 * undocumented, and silently stop checking its closed axes.
 */
export { Chip as Tag } from "@cueplusplus/ui/primitives";
