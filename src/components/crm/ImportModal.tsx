'use client';

import { useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '../../../convex/_generated/api';

interface ImportModalProps {
  onClose: () => void;
}

function parseCSV(text: string): { name: string; email?: string; phone?: string; company?: string; role?: string; location?: string }[] {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const nameIdx = headers.indexOf('name');
  if (nameIdx === -1) return [];

  const emailIdx = headers.indexOf('email');
  const phoneIdx = headers.indexOf('phone');
  const companyIdx = headers.indexOf('company');
  const roleIdx = headers.indexOf('role');
  const locationIdx = headers.indexOf('location');

  const contacts: { name: string; email?: string; phone?: string; company?: string; role?: string; location?: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    const name = cols[nameIdx];
    if (!name) continue;

    contacts.push({
      name,
      email: emailIdx >= 0 ? cols[emailIdx] || undefined : undefined,
      phone: phoneIdx >= 0 ? cols[phoneIdx] || undefined : undefined,
      company: companyIdx >= 0 ? cols[companyIdx] || undefined : undefined,
      role: roleIdx >= 0 ? cols[roleIdx] || undefined : undefined,
      location: locationIdx >= 0 ? cols[locationIdx] || undefined : undefined,
    });
  }

  return contacts;
}

export default function ImportModal({ onClose }: ImportModalProps) {
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ imported: number } | null>(null);
  const [error, setError] = useState('');

  const importCSV = useMutation(api.contacts.importCSV);

  async function handleImport() {
    if (!csv.trim()) return;
    setImporting(true);
    setError('');
    setResult(null);

    try {
      const contacts = parseCSV(csv);
      if (contacts.length === 0) {
        setError('No valid contacts found. Make sure the CSV has a "name" column header.');
        setImporting(false);
        return;
      }

      const data = await importCSV({ contacts });
      setResult(data);
    } catch {
      setError('Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[160] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative bg-card rounded-lg border w-full max-w-lg mx-4">
        <div className="px-5 py-3.5 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Import Contacts</h3>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div className="text-xs text-muted-foreground">
            Paste CSV with columns: <strong>name, email, phone, company, role, location</strong>.
            First row = headers.
          </div>

          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={'name,email,phone,company,role,location\nJane Doe,jane@example.com,555-0100,Acme Inc,Engineer,NYC'}
            rows={8}
            className="w-full px-3 py-2 text-sm rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-accent-blue/40 resize-none font-mono"
          />

          {error && (
            <div className="text-xs text-accent-red">{error}</div>
          )}

          {result && (
            <div className="text-xs text-accent-green font-medium">
              Imported {result.imported} contact{result.imported !== 1 ? 's' : ''}.
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border rounded-md hover:bg-muted transition-colors duration-150"
          >
            Close
          </button>
          {!result && (
            <button
              onClick={handleImport}
              disabled={importing || !csv.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-accent-blue rounded-md hover:opacity-90 transition-opacity duration-150 disabled:opacity-50"
            >
              {importing ? 'Importing...' : 'Import'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
