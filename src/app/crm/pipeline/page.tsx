import { notFound } from 'next/navigation';
import PipelineView from '@/components/crm/PipelineView';
import { salesPipelineEnabled } from '@/lib/crm/sales-pipeline';

export default function PipelinePage() {
  if (!salesPipelineEnabled()) notFound();
  return <PipelineView />;
}
