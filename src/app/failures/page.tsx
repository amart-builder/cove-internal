import FailureInbox from "@/components/reliability/FailureInbox";
import { getRuntimeMode } from "@/lib/runtime/mode";

export default function FailuresPage() {
  return <FailureInbox receiptsEnabled={getRuntimeMode() === "local"} />;
}
