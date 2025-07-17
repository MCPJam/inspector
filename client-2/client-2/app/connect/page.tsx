"use client";

import React from 'react';
import MainLayout from '@/app/components/ui/MainLayout';
import ServerList from '@/app/components/server-management/ServerList';
import { useRouter } from 'next/navigation';

export default function ConnectPage() {
  const router = useRouter();

  const handleServerSelect = (serverId: string) => {
    router.push(`/resources?server=${serverId}`);
  };

  return (
    <MainLayout>
      <div className="max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Connect to MCP Server</h1>
        
        <ServerList onServerSelect={handleServerSelect} />
      </div>
    </MainLayout>
  );
}