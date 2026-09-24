import { Ajv, type ErrorObject, type ValidateFunction } from "ajv"
import { Ajv2019 } from "ajv/dist/2019"
import { Ajv2020 } from "ajv/dist/2020"
import { JsonPointer, JsonSchema, Schema, SchemaAST } from "effect"

/**
 * Validates values against runtime JSON Schema documents (schemas that are
 * only known at runtime: user-authored structured-output schemas, MCP tool
 * manifests, plugin configs), surfacing failures as ordinary Effect
 * `Schema.SchemaError`s so callers handle them exactly like typed Effect
 * Schema decode failures.
 *
 * Backed by Ajv. The dialect is chosen from `$schema`: draft-07, 2019-09 and
 * 2020-12 are honored. Otherwise 2020-12 is tried first and draft-07 second,
 * so draft-07-only shapes such as tuple-form `items: [...]` still work.
 * `format` is treated as an annotation (the 2020-12 default), not asserted.
 * Remote `$ref`s are never fetched; only in-document references resolve.
 */
export function schema(jsonSchema: JsonSchema.JsonSchema): Schema.Codec<unknown> {
  return Schema.Unknown.check(check(jsonSchema))
}

/**
 * The validation as a standalone Schema check, for refining an existing
 * schema such as `Schema.Record(Schema.String, Schema.Unknown)`. Compilation
 * is deferred to the first validation, so an unusable JSON Schema fails that
 * validation with a descriptive issue instead of throwing at construction.
 */
export function check(jsonSchema: JsonSchema.JsonSchema): SchemaAST.Filter<unknown> {
  return Schema.makeFilter(
    (input) => {
      const compiled = compile(jsonSchema)
      if (typeof compiled === "string") return compiled
      if (compiled(input)) return undefined
      return (compiled.errors ?? []).map(toFilterIssue)
    },
    { expected: "a value matching the JSON Schema" },
  )
}

// Ajv's own `_cache` retains every compiled schema object forever, which would
// leak one entry per ephemeral schema. Compiled validators are cached here by
// identity instead, and evicted from Ajv right after compiling.
const compiled = new WeakMap<JsonSchema.JsonSchema, ValidateFunction | string>()
const options = { strict: false, allErrors: true, validateFormats: false, addUsedSchema: false, logger: false } as const
const instances: { draft07?: Ajv; draft2019?: Ajv2019; draft2020?: Ajv2020 } = {}
const draft07 = () => (instances.draft07 ??= new Ajv(options))
const draft2019 = () => (instances.draft2019 ??= new Ajv2019(options))
const draft2020 = () => (instances.draft2020 ??= new Ajv2020(options))

function compile(jsonSchema: JsonSchema.JsonSchema) {
  const cached = compiled.get(jsonSchema)
  if (cached) return cached
  const result = compileForDialect(jsonSchema)
  compiled.set(jsonSchema, result)
  return result
}

function compileForDialect(jsonSchema: JsonSchema.JsonSchema): ValidateFunction | string {
  const dialect = typeof jsonSchema.$schema === "string" ? jsonSchema.$schema.replace(/#$/, "") : undefined
  if (dialect === JsonSchema.META_SCHEMA_URI_DRAFT_2020_12) return compileWith(draft2020(), jsonSchema)
  if (dialect === "https://json-schema.org/draft/2019-09/schema") return compileWith(draft2019(), jsonSchema)
  if (dialect === JsonSchema.META_SCHEMA_URI_DRAFT_07) return compileWith(draft07(), jsonSchema)
  // Absent or unrecognized dialects (e.g. draft-04 from older MCP servers) are
  // compiled without `$schema`, since Ajv refuses to compile against a
  // meta-schema it does not know.
  const undeclared =
    dialect === undefined
      ? jsonSchema
      : Object.fromEntries(Object.entries(jsonSchema).filter((entry) => entry[0] !== "$schema"))
  const modern = compileWith(draft2020(), undeclared)
  if (typeof modern !== "string") return modern
  const legacy = compileWith(draft07(), undeclared)
  return typeof legacy === "string" ? modern : legacy
}

function compileWith(ajv: Ajv | Ajv2019 | Ajv2020, jsonSchema: JsonSchema.JsonSchema) {
  try {
    return ajv.compile(jsonSchema)
  } catch (error) {
    return `Invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    ajv.removeSchema(jsonSchema)
  }
}

function toFilterIssue(error: ErrorObject) {
  const path = error.instancePath
    .split("/")
    .slice(1)
    .map((token) => JsonPointer.unescapeToken(token))
    .map((token) => (/^(0|[1-9]\d*)$/.test(token) ? Number(token) : token))
  // Ajv reports these at the containing object; pointing at the key itself is clearer.
  const key =
    error.keyword === "required"
      ? error.params.missingProperty
      : error.keyword === "additionalProperties"
        ? error.params.additionalProperty
        : undefined
  return { path: typeof key === "string" ? [...path, key] : path, issue: describe(error) }
}

function describe(error: ErrorObject) {
  const message = error.message ?? `failed JSON Schema keyword "${error.keyword}"`
  if (error.keyword === "enum" && Array.isArray(error.params.allowedValues))
    return `${message}: ${error.params.allowedValues.map((value: unknown) => JSON.stringify(value)).join(", ")}`
  if (error.keyword === "const") return `${message} ${JSON.stringify(error.params.allowedValue)}`
  if (error.keyword === "additionalProperties") return "is not an allowed property"
  if (error.keyword === "required") return "is required"
  return message
}

export * as JsonSchemaValidator from "./json-schema-validator"
