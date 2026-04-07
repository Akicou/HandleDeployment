const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';

interface RailwayResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class RailwayClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    const result: RailwayResponse<T> = await response.json();

    if (result.errors && result.errors.length > 0) {
      throw new Error(result.errors[0].message);
    }

    if (!result.data) {
      throw new Error('No data returned from Railway API');
    }

    return result.data;
  }

  async getService(serviceId: string) {
    const query = `
      query service($id: String!) {
        service(id: $id) {
          id
          name
          icon
          createdAt
          projectId
        }
      }
    `;
    return this.query<{ service: { id: string; name: string; icon: string; createdAt: string; projectId: string } }>(query, { id: serviceId });
  }

  async getServiceInstance(serviceId: string, environmentId: string) {
    const query = `
      query serviceInstance($serviceId: String!, $environmentId: String!) {
        serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
          id
          serviceName
          startCommand
          buildCommand
          rootDirectory
          healthcheckPath
          region
          numReplicas
          restartPolicyType
          restartPolicyMaxRetries
          latestDeployment { id status createdAt }
        }
      }
    `;
    return this.query<{ serviceInstance: unknown }>(query, { serviceId, environmentId });
  }

  async connectService(serviceId: string, repo: string, branch: string) {
    const query = `
      mutation serviceConnect($id: String!, $input: ServiceConnectInput!) {
        serviceConnect(id: $id, input: $input) {
          id
        }
      }
    `;
    return this.query<{ serviceConnect: { id: string } }>(query, {
      id: serviceId,
      input: { repo, branch },
    });
  }

  async disconnectService(serviceId: string) {
    const query = `
      mutation serviceDisconnect($id: String!) {
        serviceDisconnect(id: $id) {
          id
        }
      }
    `;
    return this.query<{ serviceDisconnect: { id: string } }>(query, { id: serviceId });
  }

  async deployService(serviceId: string, environmentId: string) {
    const query = `
      mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    return this.query<{ serviceInstanceDeployV2: string }>(query, { serviceId, environmentId });
  }

  async redeployService(serviceId: string, environmentId: string) {
    const query = `
      mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
        serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
      }
    `;
    return this.query<{ serviceInstanceRedeploy: string }>(query, { serviceId, environmentId });
  }

  async getVariables(projectId: string, environmentId: string, serviceId?: string) {
    const query = `
      query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
        variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
      }
    `;
    return this.query<{ variables: Record<string, string> }>(query, { projectId, environmentId, serviceId });
  }

  async upsertVariable(input: {
    projectId: string;
    environmentId: string;
    serviceId?: string;
    name: string;
    value: string;
  }) {
    const query = `
      mutation variableUpsert($input: VariableUpsertInput!) {
        variableUpsert(input: $input)
      }
    `;
    return this.query<{ variableUpsert: boolean }>(query, { input });
  }

  async bulkUpsertVariables(input: {
    projectId: string;
    environmentId: string;
    serviceId?: string;
    variables: Record<string, string>;
  }) {
    const query = `
      mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `;
    return this.query<{ variableCollectionUpsert: boolean }>(query, { input });
  }

  async deleteVariable(input: {
    projectId: string;
    environmentId: string;
    serviceId?: string;
    name: string;
  }) {
    const query = `
      mutation variableDelete($input: VariableDeleteInput!) {
        variableDelete(input: $input)
      }
    `;
    return this.query<{ variableDelete: boolean }>(query, { input });
  }
}

export interface DeploymentConfig {
  name: string;
  projectId: string;
  serviceId: string;
  environmentId?: string;
  branch?: string;
  repo?: string;
}

export async function deployToRailway(token: string, config: DeploymentConfig): Promise<string> {
  const client = new RailwayClient(token);

  if (config.branch && config.repo) {
    await client.connectService(config.serviceId, config.repo, config.branch);
  }

  const environmentId = config.environmentId || 'production';
  const deploymentId = await client.deployService(config.serviceId, environmentId);

  return deploymentId;
}

export async function redeployToRailway(token: string, serviceId: string, environmentId?: string): Promise<string> {
  const client = new RailwayClient(token);
  const envId = environmentId || 'production';
  return client.redeployService(serviceId, envId);
}

export async function changeBranch(token: string, serviceId: string, repo: string, branch: string): Promise<void> {
  const client = new RailwayClient(token);
  await client.connectService(serviceId, repo, branch);
}
