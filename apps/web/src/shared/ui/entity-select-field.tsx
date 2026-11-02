/**
 * OwnerSelectField / TeamSelectField — labelled owner/team pickers for detail
 * panels and create/edit modals. Both render the shared {@link SearchableSelect}
 * in its `field` variant (a bordered form-sized box) with the identity glyph
 * before each name — round {@link OwnerAvatar} for people, square
 * {@link TeamAvatar} for teams — so every owner/team surface (grid cell, detail,
 * modal) speaks the same visual language and gets the same searchable popover.
 *
 * `onChange` emits the raw value ('' for the empty option); callers map it to
 * `null` when persisting (e.g. `onChange={(v) => update({ assigneeId: v || null })}`).
 */
import { FormField } from './form-field'
import { ownerSelectOptions } from './owner-cell'
import { TeamAvatar } from './team-cell'
import { SearchableSelect, type SelectOption } from './searchable-select'

export interface SelectableMember {
  userId: string
  displayName?: string | null
  email?: string | null
}

export interface SelectableTeam {
  id: string
  name: string
  key?: string | null
}

interface OwnerSelectFieldProps {
  value: string | null | undefined
  onChange: (value: string) => void
  members: readonly SelectableMember[]
  label?: string
  placeholder?: string
  id?: string
  disabled?: boolean
  /** Marks the field and refuses the empty option — Portfolio's create modal, where Owner is required. */
  required?: boolean
  error?: string
}

export function OwnerSelectField({
  value,
  onChange,
  members,
  label = 'Owner',
  placeholder = 'Unassigned',
  disabled,
  required,
  error,
}: OwnerSelectFieldProps) {
  return (
    <FormField label={label} required={required} error={error}>
      <SearchableSelect
        variant="field"
        value={value ?? ''}
        readOnly={disabled}
        ariaLabel={label}
        placeholder={placeholder}
        searchPlaceholder="Search"
        options={ownerSelectOptions(members, value)}
        onChange={onChange}
      />
    </FormField>
  )
}

interface TeamSelectFieldProps {
  value: string | null | undefined
  onChange: (value: string) => void
  teams: readonly SelectableTeam[]
  label?: string
  placeholder?: string
  id?: string
  disabled?: boolean
  /** When false, no empty "No team" option is offered (Team is mandatory — SoT). */
  allowUnassigned?: boolean
  error?: string
}

export function TeamSelectField({
  value,
  onChange,
  teams,
  label = 'Team',
  placeholder = 'No team',
  disabled,
  allowUnassigned = true,
  error,
}: TeamSelectFieldProps) {
  const options: SelectOption[] = [
    ...(allowUnassigned ? [{ value: '', label: placeholder }] : []),
    ...teams.map((t) => ({
      value: t.id,
      label: t.name,
      icon: <TeamAvatar teamKey={t.key} name={t.name} size={16} />,
    })),
  ]
  return (
    <FormField label={label} required={!allowUnassigned} error={error}>
      <SearchableSelect
        variant="field"
        value={value ?? ''}
        readOnly={disabled}
        ariaLabel={label}
        placeholder={allowUnassigned ? placeholder : 'Select a team'}
        searchPlaceholder="Search"
        options={options}
        onChange={onChange}
      />
    </FormField>
  )
}
