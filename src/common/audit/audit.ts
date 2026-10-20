import type { EntityManager } from 'typeorm';

export interface AuditEntry {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  meta?: Record<string, unknown>;
  ip?: string;
}

// FR-056: yönetici işlemleri ve kişisel veri görüntülemeleri. Satırlar yalnızca 2 yıllık saklama işiyle silinir.
export async function audit(tx: Pick<EntityManager, 'query'>, e: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (actor_id, action, target_type, target_id, meta, ip) VALUES ($1::uuid, $2, $3, $4, $5, $6::inet)`,
    [e.actorId, e.action, e.targetType, e.targetId, e.meta ? JSON.stringify(e.meta) : null, e.ip ?? null],
  );
}
