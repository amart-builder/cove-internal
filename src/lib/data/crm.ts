import { getDayPlanCsrfToken } from "./day-plan";
import { forgeRest } from "../supabase/rest";
import type { Company, Contact, ContactActivity } from "./types";
import { getRuntimeMode } from "../runtime/mode";

type CRMListResponse = {
  contacts: Contact[];
};

type CRMContactResponse = {
  contact: Contact | null;
  activities: ContactActivity[];
};

type CRMResolutionResponse = {
  resolution:
    | { status: "matched" | "created"; contact: Contact }
    | {
        status: "ambiguous";
        candidates: Array<{ id: string; name: string; email: string | null }>;
      };
};

type CRMCreationResponse = {
  creation: {
    contact: Contact;
    candidates: Array<{ id: string; name: string; email: string | null }>;
  };
};

async function crmGet<T>(query: Record<string, string>): Promise<T> {
  const params = new URLSearchParams(query);
  const response = await fetch(`/api/crm?${params}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `CRM request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

async function crmPost<T>(action: string, input: unknown): Promise<T> {
  const csrfToken = await getDayPlanCsrfToken();
  const response = await fetch("/api/crm", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forge-CSRF": csrfToken,
    },
    body: JSON.stringify({ action, input }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error ?? `CRM request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export async function listContacts(search?: string): Promise<Contact[]> {
  if (getRuntimeMode() !== "local") {
    return forgeRest<Contact[]>("contacts", {
      query: {
        select: "*",
        order: "name.asc",
        ...(search ? { name: `ilike.*${search}*` } : {}),
      },
    });
  }
  const response = await crmGet<CRMListResponse>({
    operation: "list",
    ...(search ? { search } : {}),
  });
  return response.contacts;
}

export async function listCompanies(): Promise<Company[]> {
  return forgeRest<Company[]>("companies", {
    query: { select: "*", order: "name.asc" },
  });
}

export async function getContact(id: string): Promise<Contact | null> {
  if (getRuntimeMode() !== "local") {
    const rows = await forgeRest<Contact[]>("contacts", {
      query: { select: "*", id: `eq.${id}`, limit: 1 },
    });
    return rows[0] ?? null;
  }
  const response = await crmGet<CRMContactResponse>({
    operation: "get",
    id,
    limit: "1",
  });
  return response.contact;
}

export async function getCompany(id: string): Promise<Company | null> {
  const rows = await forgeRest<Company[]>("companies", {
    query: { select: "*", id: `eq.${id}`, limit: 1 },
  });
  return rows[0] ?? null;
}

export async function createContact(input: {
  name: string;
  email?: string;
  company_id?: string;
  phone?: string;
  role?: string;
  tier?: string;
  tags?: string[];
}): Promise<Contact> {
  if (getRuntimeMode() !== "local") {
    const rows = await forgeRest<Contact[]>("contacts", {
      method: "POST",
      body: {
        name: input.name,
        email: input.email ?? null,
        company_id: input.company_id ?? null,
        phone: input.phone ?? null,
        role: input.role ?? null,
        tier: input.tier ?? "C",
        tags: input.tags ?? [],
      },
    });
    return rows[0];
  }
  const response = await crmPost<CRMCreationResponse>("explicit_create", {
    name: input.name,
    email: input.email,
    companyId: input.company_id,
    phone: input.phone,
    role: input.role,
    tier: input.tier,
    tags: input.tags,
    source: "manual",
  });
  return response.creation.contact;
}

export async function createCompany(input: {
  name: string;
  domain?: string;
  website?: string;
  industry?: string;
  location?: string;
  tags?: string[];
}): Promise<Company> {
  const rows = await forgeRest<Company[]>("companies", {
    method: "POST",
    body: {
      name: input.name,
      domain: input.domain ?? null,
      website: input.website ?? null,
      industry: input.industry ?? null,
      location: input.location ?? null,
      tags: input.tags ?? [],
    },
  });
  return rows[0];
}

export async function updateContact(
  id: string,
  patch: Partial<Contact>,
): Promise<Contact> {
  if (getRuntimeMode() !== "local") {
    const rows = await forgeRest<Contact[]>("contacts", {
      method: "PATCH",
      query: { id: `eq.${id}` },
      body: patch,
    });
    return rows[0];
  }
  const response = await crmPost<{ contact: Contact }>("update", {
    contactId: id,
    patch,
  });
  return response.contact;
}

export async function updateCompany(
  id: string,
  patch: Partial<Company>,
): Promise<Company> {
  const rows = await forgeRest<Company[]>("companies", {
    method: "PATCH",
    query: { id: `eq.${id}` },
    body: patch,
  });
  return rows[0];
}

export async function deleteContact(id: string): Promise<void> {
  if (getRuntimeMode() !== "local") {
    await forgeRest<undefined>("contacts", {
      method: "DELETE",
      query: { id: `eq.${id}` },
    });
    return;
  }
  await crmPost<{ ok: true }>("delete", { contactId: id });
}

export async function deleteCompany(id: string): Promise<void> {
  await forgeRest<undefined>("companies", {
    method: "DELETE",
    query: { id: `eq.${id}` },
  });
}

export async function listContactActivities(contactId: string): Promise<ContactActivity[]> {
  if (getRuntimeMode() !== "local") {
    return forgeRest<ContactActivity[]>("contact_activities", {
      query: {
        select: "*",
        contact_id: `eq.${contactId}`,
        order: "created_at.desc",
      },
    });
  }
  const response = await crmGet<CRMContactResponse>({
    operation: "get",
    id: contactId,
    limit: "500",
  });
  return response.activities;
}

export async function createContactActivity(input: {
  contact_id: string;
  activity_type: string;
  title: string;
  content?: string;
}): Promise<ContactActivity> {
  if (getRuntimeMode() !== "local") {
    const rows = await forgeRest<ContactActivity[]>("contact_activities", {
      method: "POST",
      body: {
        contact_id: input.contact_id,
        activity_type: input.activity_type,
        title: input.title,
        content: input.content ?? null,
        direction: "internal",
      },
    });
    return rows[0];
  }
  const response = await crmPost<{ activity: ContactActivity }>(
    "append_activity",
    {
      contactId: input.contact_id,
      activityType: input.activity_type,
      title: input.title,
      content: input.content,
      direction: "internal",
      source: "manual",
    },
  );
  return response.activity;
}
