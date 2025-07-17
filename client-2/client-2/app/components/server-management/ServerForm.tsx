"use client";

import React, { useState } from 'react';
import { ServerConfig } from '@/app/types/mcp';
import Button from '@/app/components/ui/Button';
import Input from '@/app/components/ui/Input';
import Select from '@/app/components/ui/Select';
import Card from '@/app/components/ui/Card';

interface ServerFormProps {
  initialValues?: Partial<ServerConfig>;
  onSubmit: (config: ServerConfig) => void;
  onCancel?: () => void;
  isSubmitting?: boolean;
}

const ServerForm: React.FC<ServerFormProps> = ({ 
  initialValues = {},
  onSubmit,
  onCancel,
  isSubmitting = false
}) => {
  const [serverType, setServerType] = useState<'stdio' | 'http'>(
    initialValues.type || 'stdio'
  );
  
  const [formData, setFormData] = useState<Partial<ServerConfig>>({
    name: '',
    description: '',
    ...initialValues
  });
  
  const [envVars, setEnvVars] = useState<[string, string][]>(
    initialValues.type === 'stdio' && initialValues.env
      ? Object.entries(initialValues.env)
      : [['', '']]
  );
  
  const [headers, setHeaders] = useState<[string, string][]>(
    initialValues.type === 'http' && initialValues.headers
      ? Object.entries(initialValues.headers)
      : [['', '']]
  );
  
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };
  
  const handleEnvVarChange = (index: number, key: string, value: string) => {
    const newEnvVars = [...envVars];
    newEnvVars[index] = [key, value];
    setEnvVars(newEnvVars);
  };
  
  const handleHeaderChange = (index: number, key: string, value: string) => {
    const newHeaders = [...headers];
    newHeaders[index] = [key, value];
    setHeaders(newHeaders);
  };
  
  const addEnvVar = () => {
    setEnvVars([...envVars, ['', '']]);
  };
  
  const addHeader = () => {
    setHeaders([...headers, ['', '']]);
  };
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Build the server config based on type
    let serverConfig: ServerConfig;
    
    if (serverType === 'stdio') {
      // Filter out empty environment variables
      const envEntries = envVars.filter(([key, value]) => key.trim() !== '');
      const env = Object.fromEntries(envEntries);
      
      serverConfig = {
        name: formData.name || 'Unnamed Server',
        description: formData.description,
        type: 'stdio',
        command: formData.command || '',
        args: formData.args?.split(' ').filter(Boolean) || [],
        env
      };
    } else {
      // Filter out empty headers
      const headerEntries = headers.filter(([key, value]) => key.trim() !== '');
      const headerObj = Object.fromEntries(headerEntries);
      
      serverConfig = {
        name: formData.name || 'Unnamed Server',
        description: formData.description,
        type: 'http',
        url: formData.url || '',
        headers: Object.keys(headerObj).length > 0 ? headerObj : undefined
      };
    }
    
    onSubmit(serverConfig);
  };
  
  return (
    <Card title={initialValues.name ? `Edit Server: ${initialValues.name}` : 'Add New Server'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Server type selection */}
        <Select
          label="Server Type"
          value={serverType}
          options={[
            { value: 'stdio', label: 'STDIO (Local Process)' },
            { value: 'http', label: 'HTTP (Remote Server)' }
          ]}
          onChange={(value) => setServerType(value as 'stdio' | 'http')}
          fullWidth
        />
        
        {/* Common fields */}
        <Input
          label="Server Name"
          name="name"
          value={formData.name || ''}
          onChange={handleInputChange}
          placeholder="My MCP Server"
          required
          fullWidth
        />
        
        <Input
          label="Description (Optional)"
          name="description"
          value={formData.description || ''}
          onChange={handleInputChange}
          placeholder="A brief description of this server"
          fullWidth
        />
        
        {/* STDIO-specific fields */}
        {serverType === 'stdio' && (
          <>
            <Input
              label="Command"
              name="command"
              value={formData.command || ''}
              onChange={handleInputChange}
              placeholder="node"
              required
              fullWidth
            />
            
            <Input
              label="Arguments (Space separated)"
              name="args"
              value={formData.args?.join(' ') || ''}
              onChange={handleInputChange}
              placeholder="server.js --port 3000"
              fullWidth
            />
            
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Environment Variables
              </label>
              
              <div className="space-y-2">
                {envVars.map(([key, value], index) => (
                  <div key={index} className="flex space-x-2">
                    <Input
                      placeholder="KEY"
                      value={key}
                      onChange={(e) => handleEnvVarChange(index, e.target.value, value)}
                      className="w-1/3"
                    />
                    <Input
                      placeholder="value"
                      value={value}
                      onChange={(e) => handleEnvVarChange(index, key, e.target.value)}
                      className="flex-1"
                    />
                  </div>
                ))}
              </div>
              
              <Button 
                type="button" 
                variant="secondary"
                size="small"
                onClick={addEnvVar}
                className="mt-2"
              >
                Add Environment Variable
              </Button>
            </div>
          </>
        )}
        
        {/* HTTP-specific fields */}
        {serverType === 'http' && (
          <>
            <Input
              label="Server URL"
              name="url"
              value={formData.url || ''}
              onChange={handleInputChange}
              placeholder="https://example.com/mcp"
              required
              fullWidth
            />
            
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Headers
              </label>
              
              <div className="space-y-2">
                {headers.map(([key, value], index) => (
                  <div key={index} className="flex space-x-2">
                    <Input
                      placeholder="Header"
                      value={key}
                      onChange={(e) => handleHeaderChange(index, e.target.value, value)}
                      className="w-1/3"
                    />
                    <Input
                      placeholder="Value"
                      value={value}
                      onChange={(e) => handleHeaderChange(index, key, e.target.value)}
                      className="flex-1"
                    />
                  </div>
                ))}
              </div>
              
              <Button 
                type="button" 
                variant="secondary"
                size="small"
                onClick={addHeader}
                className="mt-2"
              >
                Add Header
              </Button>
            </div>
          </>
        )}
        
        <div className="flex justify-end space-x-3 pt-3">
          {onCancel && (
            <Button 
              type="button" 
              variant="secondary"
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
          
          <Button 
            type="submit"
            variant="primary"
            isLoading={isSubmitting}
          >
            {initialValues.name ? 'Update Server' : 'Add Server'}
          </Button>
        </div>
      </form>
    </Card>
  );
};

export default ServerForm;