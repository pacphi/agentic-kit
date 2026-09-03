const RECOVERY_REQUIRED = Object.freeze({
  statusLabel: 'Recovery required',
  statusTone: 'blocked',
  timestampLabel: 'Updated',
  recoveryRequired: true,
  summary: 'Maintenance could not prove a complete outcome. Inspect or recover this receipt before another change.',
});

const PRESENTATION = Object.freeze({
  prepared: {
    statusLabel: 'Prepared action interrupted', statusTone: 'blocked', timestampLabel: 'Updated',
    recoveryRequired: true,
    summary: 'The action was prepared, but the journal has not been reconciled. Recover this receipt before another change.',
  },
  applying: {
    statusLabel: 'Apply interrupted', statusTone: 'blocked', timestampLabel: 'Updated',
    recoveryRequired: true,
    summary: 'A provider action may have started. Recover this receipt before another maintenance change.',
  },
  verifying: {
    statusLabel: 'Verification interrupted', statusTone: 'blocked', timestampLabel: 'Updated',
    recoveryRequired: true,
    summary: 'A provider action was recorded, but native verification did not finish. Recovery is required.',
  },
  'refreshing-catalog': {
    statusLabel: 'Catalog refresh interrupted', statusTone: 'blocked', timestampLabel: 'Updated',
    recoveryRequired: true,
    summary: 'The native outcome was recorded, but the Catalog refresh did not finish. Recovery is required.',
  },
  undoing: {
    statusLabel: 'Undo interrupted', statusTone: 'blocked', timestampLabel: 'Updated',
    recoveryRequired: true,
    summary: 'Undo started, but the restored state was not proven. Recover this receipt before another change.',
  },
  failed: RECOVERY_REQUIRED,
  partial: RECOVERY_REQUIRED,
  'partial-recovery-required': RECOVERY_REQUIRED,
  'outcome-unknown': RECOVERY_REQUIRED,
  'unknown-recovery-required': RECOVERY_REQUIRED,
  committed: {
    statusLabel: 'Change recorded', statusTone: 'ready', timestampLabel: 'Recorded',
    recoveryRequired: false,
  },
  'rolled-back': {
    statusLabel: 'Change rolled back', statusTone: 'ready', timestampLabel: 'Recorded',
    recoveryRequired: false,
  },
  'already-rolled-back': {
    statusLabel: 'Already rolled back', statusTone: 'ready', timestampLabel: 'Recorded',
    recoveryRequired: false,
    summary: 'The recorded maintenance change had already been restored.',
  },
  'aborted-no-change': {
    statusLabel: 'No change made', statusTone: 'ready', timestampLabel: 'Recorded',
    recoveryRequired: false,
    summary: 'The journal proves that no provider action started.',
  },
  'recovered-no-change': {
    statusLabel: 'No change observed', statusTone: 'ready', timestampLabel: 'Recorded',
    recoveryRequired: false,
    summary: 'Recovery inspected the provider and confirmed the recorded pre-change state.',
  },
  'already-reconciled': {
    statusLabel: 'Already reconciled', statusTone: 'ready', timestampLabel: 'Recorded',
    recoveryRequired: false,
    summary: 'This receipt had already been reconciled against current provider state.',
  },
});

function actionSummary(status, actionCount) {
  const count = Number.isInteger(actionCount) && actionCount >= 0 ? actionCount : 0;
  const noun = count === 1 ? 'action' : 'actions';
  if (status === 'committed') return `${count} maintenance ${noun} completed and verified.`;
  if (status === 'rolled-back') return `${count} maintenance ${noun} restored to the recorded pre-change state and verified.`;
  return null;
}

/** Stable, human-facing copy for durable and transient Maintenance receipts. */
export function maintenanceReceiptPresentation(status, actionCount = 0) {
  const requested = typeof status === 'string' ? status : '';
  const normalized = Object.hasOwn(PRESENTATION, requested) ? requested : 'unknown-recovery-required';
  const presentation = PRESENTATION[normalized];
  return Object.freeze({
    status: normalized,
    statusLabel: presentation.statusLabel,
    statusTone: presentation.statusTone,
    timestampLabel: presentation.timestampLabel,
    recoveryRequired: presentation.recoveryRequired,
    summary: presentation.summary ?? actionSummary(normalized, actionCount) ?? RECOVERY_REQUIRED.summary,
  });
}
