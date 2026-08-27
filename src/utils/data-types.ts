import { ConfigError } from "../errors";

type Primitive = string | number | boolean;

function assertPrimitive(value: unknown, target: string): asserts value is Primitive {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new ConfigError(`DataTypes.${target}.from: cannot convert ${typeof value} to ${target}`);
  }
}

export const DataTypes = {
  number: {
    from(value: Primitive): number {
      assertPrimitive(value, "number");
      if (typeof value === "number") return value;
      if (typeof value === "boolean") return value ? 1 : 0;
      const num = Number(value);
      if (value.trim() === "" || Number.isNaN(num)) {
        throw new ConfigError(`DataTypes.number.from: cannot convert ${JSON.stringify(value)} to number`);
      }
      return num;
    },
  },
  string: {
    from(value: Primitive): string {
      assertPrimitive(value, "string");
      return String(value);
    },
  },
  boolean: {
    from(value: Primitive): boolean {
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
  },
};
