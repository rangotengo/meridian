"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb, withTransaction } from "@/server/db/client";
import { requireSuperAdmin } from "@/server/auth/context";
import { runAction, formValues, type ActionState } from "@/server/actions/runner";
import { setFlagEnabled } from "@/server/flags";
import { enqueue, replayDeadJob } from "@/server/queue";
import {
  createInstanceInvitation,
  instanceInvitationUrl,
  revokeInstanceInvitation
} from "@/server/domain/instance-invitations";
import { env } from "@/lib/env";

const flagSchema = z.object({ key: z.string().min(1), enabled: z.enum(["on", "off"]) });

export async function toggleFlagAction(formData: FormData): Promise<void> {
  "use server";
  await requireSuperAdmin();
  const parsed = flagSchema.safeParse(formValues(formData));
  if (!parsed.success) return;
  await setFlagEnabled(getDb(), parsed.data.key, parsed.data.enabled === "on");
  revalidatePath("/admin");
}

export async function replayJobAction(formData: FormData): Promise<void> {
  "use server";
  await requireSuperAdmin();
  const jobId = String(formData.get("jobId") ?? "");
  if (!jobId) return;
  await replayDeadJob(getDb(), jobId);
  revalidatePath("/admin");
}

const instanceInviteSchema = z.object({ email: z.string().email() });

export async function createInstanceInvitationAction(
  _prev: ActionState<{ inviteUrl?: string; emailQueued: boolean }> | undefined,
  formData: FormData
): Promise<ActionState<{ inviteUrl?: string; emailQueued: boolean }>> {
  return runAction("instance_invitation.create", async () => {
    const actor = await requireSuperAdmin();
    const input = instanceInviteSchema.parse(formValues(formData));
    const targetEmail = input.email.toLowerCase().trim();
    let url = "";
    await withTransaction(async (tx) => {
      const { token } = await createInstanceInvitation(tx, actor, { email: targetEmail });
      url = instanceInvitationUrl(token);
      if (env.MAIL_TRANSPORT !== "manual")
        await enqueue(tx, "email", {
          to: targetEmail,
          subject: "You're invited to create a household on Meridian",
          text: `Accept your invitation:\n${url}\n\nThis link expires in 7 days.`
        });
    });
    revalidatePath("/admin");
    const exposeUrl = env.MAIL_TRANSPORT === "console" || env.MAIL_TRANSPORT === "manual";
    return { inviteUrl: exposeUrl ? url : undefined, emailQueued: env.MAIL_TRANSPORT !== "manual" };
  });
}

export async function revokeInstanceInvitationAction(formData: FormData): Promise<void> {
  "use server";
  const actor = await requireSuperAdmin();
  const id = String(formData.get("invitationId") ?? "");
  if (!id) return;
  await revokeInstanceInvitation(getDb(), actor, id);
  revalidatePath("/admin");
}
