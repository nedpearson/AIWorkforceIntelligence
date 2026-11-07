import { requireConsultant } from "../../_lib";
import { NewClientWizard } from "@/components/admin/new-client-wizard";
import { PLANS, EXTRA_SEAT_MONTHLY, EXTRA_AGENT_MONTHLY } from "@/engine/billing";

export const metadata = { title: "Add client — Consulting Portal" };
export const dynamic = "force-dynamic";

export default async function NewClientPage() {
  await requireConsultant();
  const plans = (Object.keys(PLANS) as (keyof typeof PLANS)[]).map((k) => ({ key: k, ...PLANS[k] }));
  return <NewClientWizard plans={plans} extraSeat={EXTRA_SEAT_MONTHLY} extraAgent={EXTRA_AGENT_MONTHLY} />;
}
