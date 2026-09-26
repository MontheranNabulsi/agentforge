/** Mirrors the organization roles; kept local so the domain imports nothing outside its module. */
export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export type ToolEffect = 'read' | 'external_read' | 'write';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ApprovalPolicyInput {
  toolName: string;
  effect: ToolEffect;
  risk: RiskLevel;
  /** Admin pre-approval configured on the agent's tool grant. */
  autoApproveGranted: boolean;
}

export interface ApprovalRequirement {
  required: boolean;
  /** True when a write runs without a person deciding because an admin pre-approved it. */
  preApproved: boolean;
  riskLevel: RiskLevel;
  approverRoles: Role[];
  expiresInMs: number;
  reason: string;
}

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Who has to say yes before an agent acts. Pure data in, decision out, so the whole policy
 * is unit-tested as a table.
 *
 * - Reads never need approval.
 * - Outbound reads (HTTP GET to an allowlisted host) don't either; the allowlist is the control.
 * - Writes need approval. Admins may pre-approve low/medium-risk tools per agent; the call is
 *   still recorded as an approval that cites the rule. High-risk writes always need a person,
 *   and only admins or owners may approve them.
 */
export function evaluateApproval(input: ApprovalPolicyInput): ApprovalRequirement {
  const base = { riskLevel: input.risk, expiresInMs: APPROVAL_TTL_MS };
  if (input.effect !== 'write') {
    return {
      ...base,
      required: false,
      preApproved: false,
      approverRoles: [],
      reason: 'Read-only action',
    };
  }
  if (input.risk === 'high') {
    return {
      ...base,
      required: true,
      preApproved: false,
      approverRoles: ['owner', 'admin'],
      reason: `${input.toolName} is high-risk: an admin or owner must approve every call`,
    };
  }
  if (input.autoApproveGranted) {
    return {
      ...base,
      required: false,
      preApproved: true,
      approverRoles: ['owner', 'admin', 'member'],
      reason: `Pre-approved by an admin for this agent (${input.toolName} is ${input.risk}-risk)`,
    };
  }
  return {
    ...base,
    required: true,
    preApproved: false,
    approverRoles: ['owner', 'admin', 'member'],
    reason: `${input.toolName} changes data outside this conversation, so a person must approve it`,
  };
}

export function mayApprove(
  role: Role,
  requirement: Pick<ApprovalRequirement, 'approverRoles'>,
): boolean {
  return requirement.approverRoles.includes(role);
}
