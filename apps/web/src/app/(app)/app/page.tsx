'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Spinner } from '@/components/ui/misc';
import { useCurrentOrg } from '@/lib/hooks';

/** /app → the organization used last (or the first shared one). */
export default function AppHome() {
  const router = useRouter();
  const { orgId } = useCurrentOrg();
  useEffect(() => {
    if (orgId) router.replace(`/o/${orgId}`);
  }, [orgId, router]);
  return <Spinner label="Opening your workspace…" />;
}
