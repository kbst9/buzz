/**
 * Pure helpers for rendering a backend provider's `config_schema`.
 *
 * Kept out of the component so the option logic is unit-testable without a DOM.
 */

/**
 * Options for a property that should render as a `<select>`, or `null` when it
 * should stay a free-text input.
 *
 * A provider that can enumerate valid values — the runtimes actually installed
 * on a host, say — should not force the operator to type one from memory.
 */
export function enumOptionsFor(
  prop: Record<string, unknown>,
  value: string,
): string[] | null {
  if (!Array.isArray(prop.enum)) return null;
  const options = prop.enum.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  if (options.length === 0) return null;

  // Surface an unrecognised current value rather than silently rewriting it to
  // the first option: a saved agent whose runtime was later uninstalled should
  // show what it was configured with, not quietly change destination.
  if (value && !options.includes(value)) return [value, ...options];
  return options;
}

/**
 * Whether a blank choice belongs in the list, so an optional field can be left
 * unset and a required one starts empty instead of silently defaulting to
 * whatever happens to sort first.
 */
export function needsBlankOption(value: string, options: string[]): boolean {
  return value === "" || !options.includes(value);
}
