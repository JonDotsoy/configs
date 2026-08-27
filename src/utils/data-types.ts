import { ConfigError } from "../errors";

type Primitive = string | number | boolean;

function assertPrimitive(value: unknown, target: string): asserts value is Primitive {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new ConfigError(`DataTypes.${target}.from: cannot convert ${typeof value} to ${target}`);
  }
}

const numberType = {
  from(value: unknown): number {
    assertPrimitive(value, "number");
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    const num = Number(value);
    if (value.trim() === "" || Number.isNaN(num)) {
      throw new ConfigError(`DataTypes.number.from: cannot convert ${JSON.stringify(value)} to number`);
    }
    return num;
  },
};

const stringType = {
  from(value: unknown): string {
    assertPrimitive(value, "string");
    return String(value);
  },
};

const booleanType = {
  from(value: unknown): boolean {
    assertPrimitive(value, "boolean");
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (value === 1) return true;
      if (value === 0) return false;
      throw new ConfigError(`DataTypes.boolean.from: cannot convert ${value} to boolean`);
    }
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    throw new ConfigError(`DataTypes.boolean.from: cannot convert ${JSON.stringify(value)} to boolean`);
  },
};

const listType = {
  /** Comma-separated string becomes a list; an array is coerced element-wise and passed through. */
  from(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((item) => stringType.from(item));
    if (typeof value === "string") return value.split(",").map((item) => item.trim());
    throw new ConfigError(`DataTypes.list.from: cannot convert ${typeof value} to list`);
  },
};

const dataTypesRegistry = {
  number: numberType,
  string: stringType,
  boolean: booleanType,
  list: listType,
};

export type DataTypeName = keyof typeof dataTypesRegistry;

/** Looks up a converter by name (e.g. from a schema's `field.type`); an unknown name throws. */
function factory(type: string): (typeof dataTypesRegistry)[DataTypeName] {
  if (type === "number" || type === "string" || type === "boolean" || type === "list") {
    return dataTypesRegistry[type];
  }
  throw new ConfigError(`DataTypes.factory: unknown type "${type}"`);
}

export const DataTypes = {
  ...dataTypesRegistry,
  factory,
};
