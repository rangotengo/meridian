export function TagPicker({
  tags,
  name = "tagIds",
  selected = [],
  onSelectedChange,
  legend = "Tags",
  disabled = false
}: {
  tags: { id: string; name: string }[];
  name?: string;
  selected?: string[];
  /**
   * When provided, the picker is controlled: checkbox state lives in the
   * caller's `selected` state instead of the DOM. Forms whose inputs must
   * survive a failed server action (React resets uncontrolled fields when
   * a form action resolves) pass this; other callers keep the uncontrolled
   * `defaultChecked` behavior with `selected` as the initial value.
   */
  onSelectedChange?: (next: string[]) => void;
  legend?: string;
  disabled?: boolean;
}) {
  if (tags.length === 0) return null;
  const controlled = onSelectedChange !== undefined;
  return (
    <fieldset disabled={disabled} className={disabled ? "opacity-60" : undefined}>
      <legend className="mb-1.5 block text-xs font-medium text-muted-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {tags.map((tag) => (
          <label
            key={tag.id}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 text-sm"
          >
            <input
              type="checkbox"
              name={name}
              value={tag.id}
              {...(controlled
                ? {
                    checked: selected.includes(tag.id),
                    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                      onSelectedChange(
                        event.target.checked
                          ? [...selected, tag.id]
                          : selected.filter((id) => id !== tag.id)
                      )
                  }
                : { defaultChecked: selected.includes(tag.id) })}
              className="h-3.5 w-3.5"
            />
            {tag.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function parseTagIds(formData: FormData, key = "tagIds"): string[] {
  return [
    ...new Set(
      formData.getAll(key).filter((v): v is string => typeof v === "string" && v.length > 0)
    )
  ];
}
