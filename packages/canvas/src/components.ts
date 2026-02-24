/**
 * A2UI (Agent-to-UI) Component Type Definitions
 *
 * Defines the full set of visual components that an AI agent can emit to
 * render a rich, interactive canvas.  Each component carries a literal
 * `type` discriminant so TypeScript can narrow the union automatically.
 *
 * This module is **pure types** except for the `isA2UIComponent` type-guard.
 */

// ---------------------------------------------------------------------------
// Base interfaces
// ---------------------------------------------------------------------------

/** Fields shared by every A2UI component. */
export interface ComponentBase {
  /** Unique identifier for the component instance. */
  id: string;
  /** Discriminant tag — one of the known A2UI component type strings. */
  type: string;
  /** Optional human-readable label. */
  label?: string;
  /** Whether the component should be rendered.  Defaults to `true`. */
  visible?: boolean;
  /** Arbitrary key/value metadata the agent can attach. */
  metadata?: Record<string, unknown>;
}

/** Spatial placement of a component on the canvas. */
export interface ComponentPosition {
  x: number;
  y: number;
  width?: number;
  height?: number;
  /** Rotation in degrees. */
  rotation?: number;
}

// ---------------------------------------------------------------------------
// Supporting / helper types
// ---------------------------------------------------------------------------

/** A clickable action surfaced on a card or similar container. */
export interface ActionButton {
  id: string;
  text: string;
  /** Logical action identifier dispatched when clicked. */
  action: string;
}

/** Dataset payload consumed by `ChartComponent`. */
export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    values: number[];
    color?: string;
  }>;
}

/** Single field definition inside a `FormComponent`. */
export interface FormField {
  name: string;
  fieldType: 'text' | 'number' | 'select' | 'checkbox' | 'textarea' | 'date';
  label: string;
  required?: boolean;
  placeholder?: string;
  /** Choices for `select` field type. */
  options?: string[];
  defaultValue?: string;
}

// ---------------------------------------------------------------------------
// Concrete component interfaces (discriminated by `type`)
// ---------------------------------------------------------------------------

/** Rich card with optional image and action buttons. */
export interface CardComponent extends ComponentBase {
  type: 'card';
  title: string;
  /** Markdown-formatted body text. */
  body: string;
  imageUrl?: string;
  actions?: ActionButton[];
}

/** Configurable chart visualisation. */
export interface ChartComponent extends ComponentBase {
  type: 'chart';
  chartType: 'bar' | 'line' | 'pie' | 'scatter' | 'area';
  data: ChartData;
  title?: string;
  xLabel?: string;
  yLabel?: string;
}

/** Dynamic form with heterogeneous field types. */
export interface FormComponent extends ComponentBase {
  type: 'form';
  title?: string;
  fields: FormField[];
  submitLabel?: string;
}

/** Standalone action button. */
export interface ButtonComponent extends ComponentBase {
  type: 'button';
  text: string;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  /** Logical action identifier dispatched on click. Falls back to component id. */
  actionId?: string;
}

/** Single-line or multi-line text input. */
export interface TextFieldComponent extends ComponentBase {
  type: 'text_field';
  placeholder?: string;
  value?: string;
  multiline?: boolean;
}

/** Tabular data with optional sorting. */
export interface DataTableComponent extends ComponentBase {
  type: 'data_table';
  columns: Array<{
    key: string;
    label: string;
    sortable?: boolean;
  }>;
  rows: Array<Record<string, unknown>>;
  title?: string;
}

/** Syntax-highlighted code block. */
export interface CodeBlockComponent extends ComponentBase {
  type: 'code_block';
  code: string;
  language?: string;
  title?: string;
  editable?: boolean;
}

/** Rendered markdown content. */
export interface MarkdownComponent extends ComponentBase {
  type: 'markdown';
  content: string;
}

/** Image display component. */
export interface ImageComponent extends ComponentBase {
  type: 'image';
  src: string;
  alt?: string;
}

/** Numeric progress indicator (0-100). */
export interface ProgressComponent extends ComponentBase {
  type: 'progress';
  /** Current progress value (0-100). */
  value: number;
  max?: number;
  status?: string;
}

/** Agent status indicator. */
export interface StatusComponent extends ComponentBase {
  type: 'status';
  state: 'idle' | 'thinking' | 'executing' | 'complete' | 'error';
  message?: string;
}

// ---------------------------------------------------------------------------
// Union & utility types
// ---------------------------------------------------------------------------

/** Discriminated union of every A2UI component. */
export type A2UIComponent =
  | CardComponent
  | ChartComponent
  | FormComponent
  | ButtonComponent
  | TextFieldComponent
  | DataTableComponent
  | CodeBlockComponent
  | MarkdownComponent
  | ImageComponent
  | ProgressComponent
  | StatusComponent;

/** String-literal union of all component type discriminants. */
export type A2UIComponentType = A2UIComponent['type'];

// ---------------------------------------------------------------------------
// Known component types
// ---------------------------------------------------------------------------

/** Set of all valid A2UI component type strings. */
export const KNOWN_COMPONENT_TYPES = new Set<string>([
  'card', 'chart', 'form', 'button', 'text_field',
  'data_table', 'code_block', 'markdown', 'image',
  'progress', 'status',
]);

// ---------------------------------------------------------------------------
// Runtime type guard
// ---------------------------------------------------------------------------

/**
 * Checks whether an unknown value has the minimal shape of an A2UI component
 * (i.e. an object with `id` and `type` string fields).
 */
export function isA2UIComponent(value: unknown): value is A2UIComponent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const obj = value as unknown as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.type === 'string';
}

/**
 * Validate type-specific required fields for an A2UI component.
 *
 * Returns an array of error strings, or empty array if valid.
 * Assumes `isA2UIComponent(value)` has already passed.
 */
export function validateComponentFields(value: A2UIComponent): string[] {
  const errors: string[] = [];

  if (!KNOWN_COMPONENT_TYPES.has(value.type)) {
    errors.push(`Unknown component type "${value.type}". Known types: ${[...KNOWN_COMPONENT_TYPES].join(', ')}.`);
    return errors;
  }

  const obj = value as unknown as Record<string, unknown>;

  switch (value.type) {
    case 'card':
      if (typeof obj.title !== 'string') errors.push('Card component requires a "title" string.');
      if (typeof obj.body !== 'string') errors.push('Card component requires a "body" string.');
      break;
    case 'chart':
      if (typeof obj.chartType !== 'string') errors.push('Chart component requires a "chartType" string.');
      if (!obj.data || typeof obj.data !== 'object') errors.push('Chart component requires a "data" object.');
      break;
    case 'form':
      if (!Array.isArray(obj.fields)) errors.push('Form component requires a "fields" array.');
      break;
    case 'button':
      if (typeof obj.text !== 'string') errors.push('Button component requires a "text" string.');
      break;
    case 'data_table':
      if (!Array.isArray(obj.columns)) errors.push('DataTable component requires a "columns" array.');
      if (!Array.isArray(obj.rows)) errors.push('DataTable component requires a "rows" array.');
      break;
    case 'code_block':
      if (typeof obj.code !== 'string') errors.push('CodeBlock component requires a "code" string.');
      break;
    case 'markdown':
      if (typeof obj.content !== 'string') errors.push('Markdown component requires a "content" string.');
      break;
    case 'image':
      if (typeof obj.src !== 'string') errors.push('Image component requires a "src" string.');
      break;
    case 'progress':
      if (typeof obj.value !== 'number') errors.push('Progress component requires a numeric "value".');
      break;
    case 'status':
      if (typeof obj.state !== 'string') errors.push('Status component requires a "state" string.');
      break;
  }

  return errors;
}
