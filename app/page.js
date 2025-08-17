// app/page.js

"use client";

import { useEffect, useState } from "react";

const BASE_URL = process.env.NEXT_PUBLIC_OCS_BASE_URL;
const TOKEN = process.env.NEXT_PUBLIC_OCS_TOKEN;
const ACCOUNT_ID = process.env.NEXT_PUBLIC_OCS_ACCOUNT_ID;

async function fetchSubscribers() {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      listSubscriber: { accountId: Number(ACCOUNT_ID) },
    }),
    cache: "no-store",
  });

  const data = await res.json();
  return data.listSubscriberRsp?.subscriber || [];
}

async function fetchPackageCost(templateId) {
  if (!templateId) return 0;

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      listPrepaidPackageTemplate: { templateId: Number(templateId) },
    }),
    cache: "no-store",
  });

  const data = await res.json();
  const templates = data.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate || [];
  return templates.length > 0 ? templates[0].cost : 0;
}

export default function Dashboard() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const subs = await fetchSubscribers();

        // add subscriberOneTimeCost
        const enriched = await Promise.all(
          subs.map(async (s) => {
            const cost = await fetchPackageCost(s.prepaidPackageTemplateId);
            return {
              iccid: s.iccid,
              lastUsageDate: s.lastUsageDate,
              prepaidPackageTemplateName: s.prepaidPackageTemplateName,
              activationDate: s.activationDate,
              tsActivationUtc: s.tsActivationUtc,
              tsExpirationUtc: s.tsExpirationUtc,
              prepaidPackageTemplateId: s.prepaidPackageTemplateId,
              pckDataByte: s.pckDataByte,
              usedDataByte: s.usedDataByte,
              subscriberUsageOverPeriod: s.subscriberUsageOverPeriod,
              subscriberOneTimeCost: cost, // ✅ now filled correctly
            };
          })
        );

        setRows(enriched);
      } catch (err) {
        console.error("❌ Error loading dashboard:", err);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, []);

  if (loading) return <div className="p-6 text-white">Loading dashboard...</div>;

  return (
    <div className="p-6 text-white">
      <h1 className="text-2xl font-bold mb-6">Teltrip Dashboard</h1>
      <div className="overflow-x-auto">
        <table className="w-full border border-gray-700">
          <thead>
            <tr className="bg-gray-900">
              <th className="p-2">ICCID</th>
              <th className="p-2">Last Usage</th>
              <th className="p-2">Template Name</th>
              <th className="p-2">Activation Date</th>
              <th className="p-2">Activation UTC</th>
              <th className="p-2">Expiration UTC</th>
              <th className="p-2">Template ID</th>
              <th className="p-2">Package Data (bytes)</th>
              <th className="p-2">Used Data (bytes)</th>
              <th className="p-2">Usage Over Period</th>
              <th className="p-2">One-Time Cost (€)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-gray-700 text-sm">
                <td className="p-2">{r.iccid}</td>
                <td className="p-2">{r.lastUsageDate}</td>
                <td className="p-2">{r.prepaidPackageTemplateName}</td>
                <td className="p-2">{r.activationDate}</td>
                <td className="p-2">{r.tsActivationUtc}</td>
                <td className="p-2">{r.tsExpirationUtc}</td>
                <td className="p-2">{r.prepaidPackageTemplateId}</td>
                <td className="p-2">{r.pckDataByte}</td>
                <td className="p-2">{r.usedDataByte}</td>
                <td className="p-2">{r.subscriberUsageOverPeriod}</td>
                <td className="p-2">{r.subscriberOneTimeCost}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
