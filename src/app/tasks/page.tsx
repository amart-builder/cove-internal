import TaskWorkspace from '@/components/tasks/TaskWorkspace';
import { getRuntimeMode } from '@/lib/runtime/mode';
import { scheduleTaskMaintenanceCatchup } from '@/lib/tasks/maintenance';

export const dynamic = 'force-dynamic';

export default function TasksPage() {
  if (getRuntimeMode() === 'local') {
    scheduleTaskMaintenanceCatchup();
  }
  return <TaskWorkspace />;
}
