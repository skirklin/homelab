import type { LifeManifest } from "./types";

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  manifest?: LifeManifest;
}

const WIDGET_TYPES = ["counter", "number", "rating", "text", "combo"] as const;
const FIELD_TYPES = ["number", "rating", "text"] as const;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && value > 0 && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && Number.isFinite(value);
}

function validateComboField(field: unknown, index: number, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const fieldPath = `${path}.fields[${index}]`;

  if (!field || typeof field !== "object") {
    errors.push({ path: fieldPath, message: "Field must be an object" });
    return errors;
  }

  const f = field as Record<string, unknown>;

  if (!isNonEmptyString(f.id)) {
    errors.push({ path: `${fieldPath}.id`, message: "Field id is required" });
  }

  if (!isNonEmptyString(f.label)) {
    errors.push({ path: `${fieldPath}.label`, message: "Field label is required" });
  }

  if (!FIELD_TYPES.includes(f.type as typeof FIELD_TYPES[number])) {
    errors.push({ path: `${fieldPath}.type`, message: `Field type must be one of: ${FIELD_TYPES.join(", ")}` });
  }

  // Validate type-specific options
  if (f.type === "number") {
    if (f.min !== undefined && !isNonNegativeNumber(f.min)) {
      errors.push({ path: `${fieldPath}.min`, message: "min must be a non-negative number" });
    }
    if (f.max !== undefined && !isPositiveNumber(f.max)) {
      errors.push({ path: `${fieldPath}.max`, message: "max must be a positive number" });
    }
    if (typeof f.min === "number" && typeof f.max === "number" && f.min >= f.max) {
      errors.push({ path: `${fieldPath}.min/max`, message: "min must be less than max" });
    }
  }

  if (f.type === "rating") {
    if (f.max === undefined || !isPositiveNumber(f.max) || f.max > 10) {
      errors.push({ path: `${fieldPath}.max`, message: "max is required for rating and must be 1-10" });
    }
  }

  return errors;
}

function validateWidget(widget: unknown, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const path = `widgets[${index}]`;

  if (!widget || typeof widget !== "object") {
    errors.push({ path, message: "Widget must be an object" });
    return errors;
  }

  const w = widget as Record<string, unknown>;

  if (!isNonEmptyString(w.id)) {
    errors.push({ path: `${path}.id`, message: "Widget id is required" });
  }

  if (!isNonEmptyString(w.label)) {
    errors.push({ path: `${path}.label`, message: "Widget label is required" });
  }

  if (!WIDGET_TYPES.includes(w.type as typeof WIDGET_TYPES[number])) {
    errors.push({ path: `${path}.type`, message: `Widget type must be one of: ${WIDGET_TYPES.join(", ")}` });
    return errors;
  }

  // Validate type-specific fields
  switch (w.type) {
    case "number":
      if (w.min !== undefined && !isNonNegativeNumber(w.min)) {
        errors.push({ path: `${path}.min`, message: "min must be a non-negative number" });
      }
      if (w.max !== undefined && !isPositiveNumber(w.max)) {
        errors.push({ path: `${path}.max`, message: "max must be a positive number" });
      }
      if (typeof w.min === "number" && typeof w.max === "number" && w.min >= w.max) {
        errors.push({ path: `${path}.min/max`, message: "min must be less than max" });
      }
      break;

    case "rating":
      if (w.max === undefined || !isPositiveNumber(w.max) || w.max > 10) {
        errors.push({ path: `${path}.max`, message: "max is required for rating and must be 1-10" });
      }
      break;

    case "combo":
      if (!Array.isArray(w.fields) || w.fields.length === 0) {
        errors.push({ path: `${path}.fields`, message: "Combo widget must have at least one field" });
      } else {
        w.fields.forEach((field, i) => {
          errors.push(...validateComboField(field, i, path));
        });
      }
      break;
  }

  return errors;
}

function validateSampleQuestion(question: unknown, index: number): ValidationError[] {
  const errors: ValidationError[] = [];
  const path = `randomSamples.questions[${index}]`;

  if (!question || typeof question !== "object") {
    errors.push({ path, message: "Question must be an object" });
    return errors;
  }

  const q = question as Record<string, unknown>;

  if (!isNonEmptyString(q.id)) {
    errors.push({ path: `${path}.id`, message: "Question id is required" });
  }

  if (!isNonEmptyString(q.label)) {
    errors.push({ path: `${path}.label`, message: "Question label is required" });
  }

  if (!FIELD_TYPES.includes(q.type as typeof FIELD_TYPES[number])) {
    errors.push({ path: `${path}.type`, message: `Question type must be one of: ${FIELD_TYPES.join(", ")}` });
  }

  if (q.type === "rating" && (q.max === undefined || !isPositiveNumber(q.max) || q.max > 10)) {
    errors.push({ path: `${path}.max`, message: "max is required for rating and must be 1-10" });
  }

  return errors;
}

function validateRandomSamples(samples: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  const path = "randomSamples";

  if (!samples || typeof samples !== "object") {
    errors.push({ path, message: "randomSamples must be an object" });
    return errors;
  }

  const s = samples as Record<string, unknown>;

  if (typeof s.enabled !== "boolean") {
    errors.push({ path: `${path}.enabled`, message: "enabled must be a boolean" });
  }

  if (!isPositiveNumber(s.timesPerDay) || s.timesPerDay > 24) {
    errors.push({ path: `${path}.timesPerDay`, message: "timesPerDay must be 1-24" });
  }

  if (!Array.isArray(s.activeHours) || s.activeHours.length !== 2) {
    errors.push({ path: `${path}.activeHours`, message: "activeHours must be [startHour, endHour]" });
  } else {
    const [start, end] = s.activeHours;
    if (typeof start !== "number" || start < 0 || start > 23) {
      errors.push({ path: `${path}.activeHours[0]`, message: "Start hour must be 0-23" });
    }
    if (typeof end !== "number" || end < 0 || end > 23) {
      errors.push({ path: `${path}.activeHours[1]`, message: "End hour must be 0-23" });
    }
    if (typeof start === "number" && typeof end === "number" && start >= end) {
      errors.push({ path: `${path}.activeHours`, message: "Start hour must be before end hour" });
    }
  }

  if (!Array.isArray(s.questions)) {
    errors.push({ path: `${path}.questions`, message: "questions must be an array" });
  } else {
    s.questions.forEach((q, i) => {
      errors.push(...validateSampleQuestion(q, i));
    });
  }

  return errors;
}

export function validateManifest(input: unknown): ValidationResult {
  const errors: ValidationError[] = [];

  if (!input || typeof input !== "object") {
    return {
      valid: false,
      errors: [{ path: "", message: "Manifest must be an object" }],
    };
  }

  const manifest = input as Record<string, unknown>;

  // Validate widgets array
  if (!Array.isArray(manifest.widgets)) {
    errors.push({ path: "widgets", message: "widgets must be an array" });
  } else if (manifest.widgets.length === 0) {
    errors.push({ path: "widgets", message: "At least one widget is required" });
  } else {
    // Check for duplicate IDs
    const ids = new Set<string>();
    manifest.widgets.forEach((w, i) => {
      const widget = w as Record<string, unknown>;
      if (typeof widget?.id === "string") {
        if (ids.has(widget.id)) {
          errors.push({ path: `widgets[${i}].id`, message: `Duplicate widget id: ${widget.id}` });
        }
        ids.add(widget.id);
      }
      errors.push(...validateWidget(w, i));
    });
  }

  // Validate randomSamples
  if (manifest.randomSamples === undefined) {
    errors.push({ path: "randomSamples", message: "randomSamples is required" });
  } else {
    errors.push(...validateRandomSamples(manifest.randomSamples));
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Type assertion after validation passes
  return {
    valid: true,
    errors: [],
    manifest: manifest as unknown as LifeManifest,
  };
}

// Parse JSON and validate
export function parseAndValidateManifest(json: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {
      valid: false,
      errors: [{ path: "", message: "Invalid JSON" }],
    };
  }

  return validateManifest(parsed);
}

// Format validation errors for display
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map(e => `${e.path}: ${e.message}`).join("\n");
}
