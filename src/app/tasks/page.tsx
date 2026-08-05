import TaskWorkspace from '@/components/tasks/TaskWorkspace';
import { getRuntimeMode } from '@/lib/runtime/mode';
import { scheduleTaskMaintenanceCatchup } from '@/lib/tasks/maintenance';

export const dynamic = 'force-dynamic';

export default function TasksPage() {
  if (getRuntimeMode() === 'local') {
    // Opening the app is the trigger, so this call is deliberate here. It is not
    // per-request work: a module-level guard runs the catch-up at most once per
    // local day and setImmediate keeps it off the render path.
    scheduleTaskMaintenanceCatchup();
  }
  return <TaskWorkspace />;
}
