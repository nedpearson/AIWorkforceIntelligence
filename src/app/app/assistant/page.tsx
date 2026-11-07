import { requireCtx } from "@/lib/session";
import { can } from "@/lib/rbac";
import { AssistantClient } from "./assistant-client";

export const metadata = { title: "Ask BridgeBox" };
export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const ctx = await requireCtx("workflows:read");
  return <AssistantClient llmConfigured={!!process.env.ANTHROPIC_API_KEY} canManage={can(ctx.role, "org:manage")} orgName={ctx.orgName} />;
}
