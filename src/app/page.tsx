import { redirect } from "next/navigation";
import { getCtx } from "@/lib/session";
export default async function Home() {
  const ctx = await getCtx();
  redirect(ctx ? "/app" : "/login");
}
