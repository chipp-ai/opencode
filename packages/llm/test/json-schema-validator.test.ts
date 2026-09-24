import { describe, expect, test } from "bun:test"
import { Exit, JsonSchema, Schema, SchemaIssue } from "effect"
import { JsonSchemaValidator } from "../src"

const validate = (jsonSchema: JsonSchema.JsonSchema, value: unknown) =>
  Schema.decodeUnknownExit(JsonSchemaValidator.schema(jsonSchema))(value)

const issues = (jsonSchema: JsonSchema.JsonSchema, value: unknown) => {
  const exit = validate(jsonSchema, value)
  if (Exit.isSuccess(exit)) throw new Error(`expected ${JSON.stringify(value)} to be rejected`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
  if (!Schema.isSchemaError(error)) throw new Error("expected a SchemaError failure")
  return SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
    path: issue.path?.map((segment) => (typeof segment === "object" ? segment.key : segment)) ?? [],
    message: issue.message,
  }))
}

const accepts = (jsonSchema: JsonSchema.JsonSchema, value: unknown) => {
  const exit = validate(jsonSchema, value)
  expect(Exit.isSuccess(exit)).toBe(true)
  if (Exit.isSuccess(exit)) expect(exit.value).toEqual(value)
}

const person = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    age: { type: "integer", minimum: 0 },
    role: { enum: ["admin", "member"] },
    kind: { const: "person" },
    tags: { type: "array", items: { type: "string" }, maxItems: 2 },
    address: {
      type: "object",
      properties: { city: { type: "string" }, zip: { type: "string", pattern: "^[0-9]{5}$" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
  required: ["name", "age"],
}

describe("JsonSchemaValidator", () => {
  test("accepts a value matching an object schema and returns it unchanged", () => {
    accepts(person, {
      name: "Ada",
      age: 36,
      role: "admin",
      kind: "person",
      tags: ["math"],
      address: { city: "London", zip: "12345" },
    })
  })

  test("reports missing required properties at the property path", () => {
    expect(issues(person, { name: "Ada" })).toEqual([{ path: ["age"], message: "is required" }])
  })

  test("reports type mismatches at the offending path", () => {
    expect(issues(person, { name: "Ada", age: "36" })).toEqual([{ path: ["age"], message: "must be integer" }])
    expect(issues(person, { name: "Ada", age: 1.5 })).toEqual([{ path: ["age"], message: "must be integer" }])
    expect(issues({ type: "object" }, [])).toEqual([{ path: [], message: "must be object" }])
    expect(issues({ type: "number" }, "1")).toEqual([{ path: [], message: "must be number" }])
    expect(issues({ type: "boolean" }, 0)).toEqual([{ path: [], message: "must be boolean" }])
    expect(issues({ type: "null" }, undefined)).toEqual([{ path: [], message: "must be null" }])
  })

  test("enforces enum and const with the expected values in the message", () => {
    expect(issues(person, { name: "Ada", age: 1, role: "owner" })).toEqual([
      { path: ["role"], message: 'must be equal to one of the allowed values: "admin", "member"' },
    ])
    expect(issues(person, { name: "Ada", age: 1, kind: "robot" })).toEqual([
      { path: ["kind"], message: 'must be equal to constant "person"' },
    ])
  })

  test("validates nested objects, including additionalProperties: false", () => {
    expect(issues(person, { name: "Ada", age: 1, address: { zip: "1", extra: true } })).toEqual([
      { path: ["address", "city"], message: "is required" },
      { path: ["address", "extra"], message: "is not an allowed property" },
      { path: ["address", "zip"], message: 'must match pattern "^[0-9]{5}$"' },
    ])
  })

  test("validates array items with numeric index paths and length bounds", () => {
    expect(issues(person, { name: "Ada", age: 1, tags: ["a", 2] })).toEqual([
      { path: ["tags", 1], message: "must be string" },
    ])
    expect(issues(person, { name: "Ada", age: 1, tags: ["a", "b", "c"] })).toEqual([
      { path: ["tags"], message: "must NOT have more than 2 items" },
    ])
    accepts({ type: "array", items: { type: "object", required: ["id"] } }, [{ id: 1 }, { id: 2 }])
  })

  test("reports every failure at once", () => {
    expect(issues(person, { name: "", age: -1 })).toEqual([
      { path: ["name"], message: "must NOT have fewer than 1 characters" },
      { path: ["age"], message: "must be >= 0" },
    ])
  })

  test("supports anyOf, oneOf and allOf composition", () => {
    const stringOrNumber = { anyOf: [{ type: "string" }, { type: "number" }] }
    accepts(stringOrNumber, "x")
    accepts(stringOrNumber, 1)
    expect(issues(stringOrNumber, true).at(-1)).toEqual({ path: [], message: "must match a schema in anyOf" })

    const exactlyOne = { oneOf: [{ type: "number" }, { type: "integer" }] }
    accepts(exactlyOne, 1.5)
    expect(issues(exactlyOne, 1)).toEqual([{ path: [], message: "must match exactly one schema in oneOf" }])

    const both = { allOf: [{ required: ["a"] }, { required: ["b"] }] }
    accepts(both, { a: 1, b: 2 })
    expect(issues(both, { a: 1 })).toEqual([{ path: ["b"], message: "is required" }])
  })

  test("supports conditional and pattern keywords", () => {
    const conditional = {
      type: "object",
      if: { properties: { kind: { const: "email" } } },
      then: { required: ["address"] },
      patternProperties: { "^x-": { type: "string" } },
    }
    accepts(conditional, { kind: "sms", "x-trace": "abc" })
    expect(issues(conditional, { kind: "email" })).toEqual([
      { path: ["address"], message: "is required" },
      { path: [], message: 'must match "then" schema' },
    ])
    expect(issues(conditional, { kind: "sms", "x-trace": 1 })).toEqual([
      { path: ["x-trace"], message: "must be string" },
    ])
  })

  test("resolves local $ref through $defs and draft-07 definitions", () => {
    const node = {
      $defs: { Leaf: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } },
      definitions: { Name: { type: "string" } },
      type: "object",
      properties: { leaf: { $ref: "#/$defs/Leaf" }, name: { $ref: "#/definitions/Name" } },
    }
    accepts(node, { leaf: { value: 1 }, name: "n" })
    expect(issues(node, { leaf: {}, name: 1 })).toEqual([
      { path: ["leaf", "value"], message: "is required" },
      { path: ["name"], message: "must be string" },
    ])
  })

  test("supports recursive schemas", () => {
    const tree = {
      $defs: { Tree: { type: "object", properties: { children: { type: "array", items: { $ref: "#/$defs/Tree" } } } } },
      $ref: "#/$defs/Tree",
    }
    accepts(tree, { children: [{ children: [] }] })
    expect(issues(tree, { children: [{ children: [1] }] })).toEqual([
      { path: ["children", 0, "children", 0], message: "must be object" },
    ])
  })

  test("escapes JSON Pointer tokens in property paths", () => {
    expect(issues({ properties: { "a/b~c": { type: "string" } } }, { "a/b~c": 1 })).toEqual([
      { path: ["a/b~c"], message: "must be string" },
    ])
  })

  test("honors declared dialects and falls back to draft-07 for tuple-form items", () => {
    accepts({ $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, prefixItems: [{ type: "string" }] }, ["a"])
    accepts({ $schema: "https://json-schema.org/draft/2019-09/schema", type: "object" }, {})
    const tuple = { $schema: "http://json-schema.org/draft-07/schema#", type: "array", items: [{ type: "string" }] }
    expect(issues(tuple, [1])).toEqual([{ path: [0], message: "must be string" }])
    expect(issues({ type: "array", items: [{ type: "string" }] }, [1])).toEqual([
      { path: [0], message: "must be string" },
    ])
    expect(issues({ $schema: "http://json-schema.org/draft-04/schema#", type: "string" }, 1)).toEqual([
      { path: [], message: "must be string" },
    ])
  })

  test("treats format as an annotation rather than an assertion", () => {
    accepts({ type: "string", format: "email" }, "not an email")
  })

  test("fails validation with a descriptive issue for an invalid schema instead of throwing", () => {
    const invalid = { type: "not-a-type" }
    expect(() => JsonSchemaValidator.schema(invalid)).not.toThrow()
    const [issue] = issues(invalid, {})
    expect(issue?.message).toStartWith("Invalid JSON Schema:")
  })

  test("never fetches remote references", () => {
    const [issue] = issues({ $ref: "https://example.com/schema.json" }, {})
    expect(issue?.message).toContain("can't resolve reference https://example.com/schema.json")
  })

  test("reuses the compiled validator for the same schema object", () => {
    const jsonSchema = { type: "object", required: ["id"] }
    const decode = Schema.decodeUnknownExit(JsonSchemaValidator.schema(jsonSchema))
    expect(Exit.isSuccess(decode({ id: 1 }))).toBe(true)
    expect(Exit.isFailure(decode({}))).toBe(true)
    expect(Exit.isSuccess(decode({ id: 2 }))).toBe(true)
  })

  test("check refines an existing schema", () => {
    const record = Schema.Record(Schema.String, Schema.Unknown).check(
      JsonSchemaValidator.check({ type: "object", required: ["answer"] }),
    )
    expect(Exit.isSuccess(Schema.decodeUnknownExit(record)({ answer: 42 }))).toBe(true)
    expect(Exit.isFailure(Schema.decodeUnknownExit(record)({}))).toBe(true)
    expect(Exit.isFailure(Schema.decodeUnknownExit(record)("not a record"))).toBe(true)
  })
})
