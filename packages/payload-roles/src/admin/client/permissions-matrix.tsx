import { FieldDescription, FieldLabel, useField } from "@payloadcms/ui";
import type { JSONFieldClientProps } from "payload";
import React, { type ChangeEvent, useId, useMemo, useState } from "react";

import type { Grant, MatrixModel, ResourceId, StorageKind } from "../model.ts";
import {
  applyOp,
  type Cells,
  grantableCells,
  type MatrixOp,
  pickerWarning,
  placeFieldErrors,
  readMatrix,
} from "./matrix.ts";

export type PermissionsMatrixProps = {
  field: JSONFieldClientProps["field"];
  path: string;
  model: MatrixModel;
};

const EMPTY: Cells = new Set();

const GROUPS: readonly { kind: StorageKind; label: string }[] = [
  { kind: "collections", label: "Collections" },
  { kind: "globals", label: "Globals" },
];

const CSS = `
.roles-matrix { margin-bottom: var(--base); }
.roles-matrix__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.roles-matrix__toolbar { display: flex; flex-wrap: wrap; gap: calc(var(--base) * 0.5) var(--base); align-items: end; margin-bottom: calc(var(--base) * 0.5); }
.roles-matrix__control { display: flex; flex-direction: column; gap: calc(var(--base) * 0.2); }
.roles-matrix__control-row { display: flex; gap: calc(var(--base) * 0.25); }
.roles-matrix input[type="search"], .roles-matrix select { min-height: calc(var(--base) * 1.6); padding: 0 calc(var(--base) * 0.4); border: 1px solid var(--theme-border-color); border-radius: var(--style-radius-s); background: var(--theme-input-bg); color: var(--theme-text); font: inherit; }
.roles-matrix button { min-height: calc(var(--base) * 1.2); padding: 0 calc(var(--base) * 0.4); border: 1px solid var(--theme-border-color); border-radius: var(--style-radius-s); background: var(--theme-elevation-0); color: var(--theme-text); font: inherit; font-size: 0.85em; cursor: pointer; }
.roles-matrix button:hover:not(:disabled) { background: var(--theme-elevation-100); }
.roles-matrix button:disabled { cursor: default; opacity: 0.5; }
.roles-matrix__notice { margin: 0 0 calc(var(--base) * 0.5); padding: calc(var(--base) * 0.4) calc(var(--base) * 0.6); border-left: 3px solid var(--theme-elevation-400); border-radius: var(--style-radius-s); background: var(--theme-elevation-50); }
.roles-matrix__notice p, .roles-matrix__notice ul { margin: 0; }
.roles-matrix__notice ul { padding-left: var(--base); }
.roles-matrix__notice button { margin-top: calc(var(--base) * 0.3); }
.roles-matrix__notice--error { border-left-color: var(--theme-error-500); }
.roles-matrix__error { display: block; color: var(--theme-error-500); font-weight: normal; font-size: 0.85em; }
.roles-matrix__scroll { overflow: auto; max-height: 70vh; border: 1px solid var(--theme-border-color); border-radius: var(--style-radius-s); }
.roles-matrix table { width: 100%; border-collapse: separate; border-spacing: 0; }
.roles-matrix th, .roles-matrix td { padding: calc(var(--base) * 0.3) calc(var(--base) * 0.5); border-bottom: 1px solid var(--theme-border-color); background: var(--theme-elevation-0); text-align: center; white-space: nowrap; }
.roles-matrix thead th { position: sticky; top: 0; z-index: 2; background: var(--theme-elevation-50); font-weight: 600; vertical-align: bottom; }
.roles-matrix thead th button { display: block; margin: calc(var(--base) * 0.2) auto 0; }
.roles-matrix thead th:first-child, .roles-matrix tbody th[scope="row"] { position: sticky; left: 0; z-index: 1; text-align: left; }
.roles-matrix thead th:first-child { z-index: 3; }
.roles-matrix tbody th[scope="rowgroup"] { background: var(--theme-elevation-100); text-align: left; font-weight: 600; }
.roles-matrix tbody th[scope="row"] { font-weight: normal; }
.roles-matrix input[type="checkbox"] { width: calc(var(--base) * 0.8); height: calc(var(--base) * 0.8); margin: 0; accent-color: var(--theme-elevation-800); cursor: pointer; }
.roles-matrix input[type="checkbox"]:disabled { cursor: default; }
`;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const Notice = ({ children, error = false }: { children: React.ReactNode; error?: boolean }) => (
  <div className={`roles-matrix__notice${error ? " roles-matrix__notice--error" : ""}`}>
    {children}
  </div>
);

const ToggleButton = ({
  cells,
  disabled,
  onToggle,
  subject,
  targets,
}: {
  cells: Cells;
  disabled: boolean;
  onToggle: () => void;
  subject: string;
  targets: readonly Grant[];
}) => {
  const clears = targets.length > 0 && targets.every((cell) => cells.has(cell));
  const text = clears ? "Clear" : "All";
  return (
    <button
      aria-label={`${text} ${subject}`}
      disabled={disabled || targets.length === 0}
      onClick={onToggle}
      type="button"
    >
      {text}
    </button>
  );
};

export const PermissionsMatrix = ({ field, path, model }: PermissionsMatrixProps) => {
  const { value, setValue, errorMessage, showError } = useField<unknown>({
    potentiallyStalePath: path,
  });
  const view = useMemo(() => readMatrix(model, value), [model, value]);
  const shownError = showError && typeof errorMessage === "string" ? errorMessage : "";
  const placed = useMemo(() => placeFieldErrors(model, shownError), [model, shownError]);
  const [filter, setFilter] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [report, setReport] = useState<{
    value: unknown;
    name: string;
    skipped: readonly Grant[];
  } | null>(null);
  const id = useId();

  const { cellOf, labelOf } = useMemo(() => {
    const cellsByValue = new Map<string, Grant>();
    const labels = new Map<Grant, string>();
    for (const row of model.rows) {
      for (const column of model.columns) {
        if (row.cells[column.action] !== undefined) {
          const cell: Grant = `${row.id}#${column.action}`;
          cellsByValue.set(cell, cell);
          labels.set(cell, `${row.label}: ${column.label}`);
        }
      }
    }
    return { cellOf: cellsByValue, labelOf: labels };
  }, [model]);

  const ready = view.status === "ready";
  const cells = ready ? view.cells : EMPTY;
  const canEdit = ready && model.rows.some((row) => Object.values(row.cells).includes("grantable"));
  const needle = filter.trim().toLowerCase();
  const visible = model.rows.filter(
    (row) =>
      needle === "" ||
      row.label.toLowerCase().includes(needle) ||
      row.slug.toLowerCase().includes(needle),
  );
  const visibleIds: readonly ResourceId[] = visible.map((row) => row.id);
  const describe = (list: readonly Grant[]) =>
    list.map((cell) => labelOf.get(cell) ?? cell).join(", ");

  const run = (op: MatrixOp) => {
    if (view.status !== "ready") {
      return null;
    }
    const outcome = applyOp(model, view.cells, op);
    setValue(outcome.value);
    return outcome;
  };

  const onCell = (event: ChangeEvent<HTMLInputElement>) => {
    const cell = cellOf.get(event.currentTarget.value);
    if (cell) {
      run({ type: "cell", cell, on: event.currentTarget.checked });
    }
  };

  const source = model.copySources.find((candidate) => candidate.id === sourceId);
  const onCopy = () => {
    if (!source) {
      return;
    }
    const outcome = run({ type: "copy", source });
    if (outcome) {
      setReport({ value: outcome.value, name: source.name, skipped: outcome.skipped });
    }
  };

  const description = field.admin?.description;
  const fieldErrors = placed.field;
  const columnCount = model.columns.length + 2;

  return (
    <div className={`field-type json roles-matrix${fieldErrors.length > 0 ? " error" : ""}`}>
      <style>{CSS}</style>
      <FieldLabel
        label={
          typeof field.label === "string" || typeof field.label === "object"
            ? field.label
            : "Permissions"
        }
        path={path}
        required={field.required === true}
      />
      {typeof description === "string" || typeof description === "object" ? (
        <FieldDescription description={description} path={path} />
      ) : null}
      {model.enforced ? null : (
        <Notice>
          <p>
            Role limits are not enforced. The roles plugin is disabled, so these permissions have no
            effect until it is enabled.
          </p>
        </Notice>
      )}
      {model.lock?.kind === "read-only" ? (
        <Notice>
          <p>You can view this role but cannot change it.</p>
        </Notice>
      ) : null}
      {model.lock?.kind === "not-covered" ? (
        <Notice>
          <p>
            You cannot change this role because it grants permissions you do not hold:{" "}
            {describe(model.lock.missing)}.
          </p>
        </Notice>
      ) : null}
      {ready ? null : (
        <Notice error>
          <p>These permissions cannot be shown as a matrix. Reload the page before editing them.</p>
        </Notice>
      )}
      {view.status === "ready" && view.untouched && model.stored.issues.length > 0 ? (
        <Notice error>
          <p>The stored permissions have entries the plugin rejects on save:</p>
          <ul>
            {model.stored.issues.map((issue) => (
              <li key={`${issue.row ?? ""}${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
          {canEdit ? (
            <button onClick={() => run({ type: "clean" })} type="button">
              Remove invalid entries
            </button>
          ) : null}
        </Notice>
      ) : null}
      {pickerWarning(model, cells) ? (
        <Notice>
          <p>
            Holders can edit users, but the Roles picker on a user stays empty without Read on
            Roles. A role grants nothing implicitly.
          </p>
        </Notice>
      ) : null}
      {report !== null && report.value === value ? (
        <Notice>
          <p role="status">
            Copied from {report.name}.
            {report.skipped.length > 0
              ? ` ${plural(report.skipped.length, "cell")} kept their value because you cannot change them: ${describe(report.skipped)}.`
              : ""}
          </p>
        </Notice>
      ) : null}
      {fieldErrors.length > 0 ? (
        <Notice error>
          <ul role="alert">
            {fieldErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="roles-matrix__toolbar">
        <div className="roles-matrix__control">
          <label htmlFor={`${id}-filter`}>Filter resources</label>
          <input
            id={`${id}-filter`}
            onChange={(event) => setFilter(event.currentTarget.value)}
            type="search"
            value={filter}
          />
        </div>
        {model.copySources.length > 0 ? (
          <div className="roles-matrix__control">
            <label htmlFor={`${id}-copy`}>Copy from role</label>
            <div className="roles-matrix__control-row">
              <select
                disabled={!canEdit}
                id={`${id}-copy`}
                onChange={(event) => setSourceId(event.currentTarget.value)}
                value={sourceId}
              >
                <option value="">Choose a role</option>
                {model.copySources.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              <button disabled={!canEdit || !source} onClick={onCopy} type="button">
                Copy
              </button>
            </div>
          </div>
        ) : null}
        {model.assignment ? (
          <a href={model.assignment.href}>Assigned to {plural(model.assignment.count, "user")}</a>
        ) : null}
      </div>
      <div className="roles-matrix__scroll">
        <table>
          <caption className="roles-matrix__sr">Permissions by resource and action</caption>
          <thead>
            <tr>
              <th scope="col">Resource</th>
              {model.columns.map((column) => (
                <th key={column.action} scope="col">
                  {column.label}
                  <ToggleButton
                    cells={cells}
                    disabled={!canEdit}
                    onToggle={() =>
                      run({ type: "column", action: column.action, rows: visibleIds })
                    }
                    subject={`${column.label} on shown resources`}
                    targets={visible.flatMap((row) => grantableCells(row, [column.action]))}
                  />
                </th>
              ))}
              <th scope="col">
                <span className="roles-matrix__sr">Whole row</span>
              </th>
            </tr>
          </thead>
          {GROUPS.map((group) => {
            const rows = visible.filter((row) => row.kind === group.kind);
            return rows.length === 0 ? null : (
              <tbody key={group.kind}>
                <tr>
                  <th colSpan={columnCount} scope="rowgroup">
                    {group.label}
                  </th>
                </tr>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      {row.label}
                      {(placed.byRow.get(row.id) ?? []).map((message) => (
                        <span className="roles-matrix__error" key={message} role="alert">
                          {message}
                        </span>
                      ))}
                    </th>
                    {model.columns.map((column) => {
                      const mode = row.cells[column.action];
                      const cell: Grant = `${row.id}#${column.action}`;
                      return (
                        <td key={column.action}>
                          {mode === undefined ? (
                            <span className="roles-matrix__sr">Not applicable</span>
                          ) : (
                            <input
                              aria-label={`${row.label}: ${column.label}`}
                              checked={cells.has(cell)}
                              disabled={!ready || mode === "fixed"}
                              onChange={onCell}
                              type="checkbox"
                              value={cell}
                            />
                          )}
                        </td>
                      );
                    })}
                    <td>
                      <ToggleButton
                        cells={cells}
                        disabled={!canEdit}
                        onToggle={() => run({ type: "row", row: row.id })}
                        subject={`${row.label} permissions`}
                        targets={grantableCells(
                          row,
                          model.columns.map((column) => column.action),
                        )}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
        {visible.length === 0 ? (
          <p className="roles-matrix__notice">No resources match the filter.</p>
        ) : null}
      </div>
    </div>
  );
};
