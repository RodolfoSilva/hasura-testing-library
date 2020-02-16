import Docker from 'dockerode';
import crypto from 'crypto';
import path from 'path';

function sha1(data: any) {
  return crypto
    .createHash('sha1')
    .update(data, 'binary' as any)
    .digest('hex')
    .slice(0, 12);
}

const until = async (
  fn: () => Promise<any>,
  retries: number = 10,
  delayMs: number = 1000
): Promise<any> => {
  try {
    const result = await fn();
    return result;
  } catch (e) {
    if (retries <= 1) {
      return Promise.reject(e);
    }
    await new Promise(r => setTimeout(r, delayMs));
    return until(fn, retries - 1, delayMs);
  }
};

var docker = new Docker();

function runExec(container: any, options: any) {
  return new Promise((resolve, reject) => {
    container.exec(options, function(err: any, exec: any) {
      if (err) return reject(err);
      exec.start(function(err: any, stream: any) {
        if (err) return reject(err);

        container.modem.demuxStream(stream, process.stdout, process.stderr);
      });

      const inspectUntilStopRuning = () => {
        setTimeout(() => {
          exec.inspect(function(err: any, data: any) {
            if (err) return reject(err);

            if (data.Running) return inspectUntilStopRuning();

            if (data.ExitCode) {
              return reject(
                new Error(
                  `${data.ProcessConfig.entrypoint} exited with code ${data.ExitCode}`
                )
              );
            }

            resolve();
          });
        }, 100);
      };

      inspectUntilStopRuning();
    });
  });
}

function pull(image: string, options?: any) {
  return new Promise(function(resolve, reject) {
    docker.pull(image, options, function(error, stream) {
      if (error) return reject(error);
      docker.modem.followProgress(
        stream,
        function(error: any) {
          if (error) return reject(error);
          resolve();
        },
        function() {
          // log.info({ event: event }, 'Pull Progress:');
        }
      );
    });
  });
}

const startPostgres = (testId: string) =>
  new Promise(async (resolve, reject) => {
    await pull('postgres:12-alpine');

    const container = await docker.createContainer({
      name: `postgres_${testId}`,
      Image: 'postgres:12-alpine',
      AttachStderr: false,
      AttachStdout: false,
      OpenStdin: false,
      Tty: true,
      Env: ['POSTGRES_PASSWORD=postgres'],
      HostConfig: {
        AutoRemove: true,
        NetworkMode: `network_${testId}`,
      },
    });

    await container.start();

    try {
      await until(
        () =>
          runExec(container, {
            Cmd: ['psql', '-U', 'postgres', '-c', '\\q'],
            Env: ['PGPASSWORD=postgres'],
          }),
        20
      );

      await runExec(container, {
        Cmd: ['psql', '-U', 'postgres', '-c', `create database ${testId}`],
        Env: ['PGPASSWORD=postgres'],
      });
      resolve(container);
    } catch (e) {
      await container.stop();
      reject(e);
    }
  });

const startHasura = (testId: string) =>
  new Promise(async (resolve, reject) => {
    await pull('hasura/graphql-engine:v1.0.0.cli-migrations');

    const container = await docker.createContainer({
      name: `hasura_${testId}`,
      Image: 'hasura/graphql-engine:v1.0.0.cli-migrations',
      Env: [
        `HASURA_GRAPHQL_DATABASE_URL=postgres://postgres:postgres@postgres:5432/${testId}`,
      ],
      HostConfig: {
        AutoRemove: true,
        NetworkMode: `network_${testId}`,
        Binds: [
          `${path.join(
            process.cwd(),
            '/migrations/'
          )}:/tmp/hasura-test/migrations`,
        ],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [`network_${testId}`]: {
            Links: [`postgres_${testId}:postgres`],
          },
        },
      },
    });

    await container.start();

    try {
      console.log('Check hasura is avaliable');
      await until(
        () =>
          runExec(container, {
            AttachStderr: true,
            Cmd: ['nc', '-z', 'localhost', '8080'],
          }),
        100
      );

      await runExec(container, {
        AttachStderr: true,
        AttachStdout: true,
        Cmd: [
          'sh',
          '-c',
          [
            'cd /tmp/hasura-test',
            'echo "endpoint: http://localhost:8080" > config.yaml',
            'echo "show_update_notification: false" >> config.yaml',
            'hasura-cli migrate apply',
            'if [ -f metadata.json ] || [ -f metadata.yaml ] ; then hasura-cli metadata apply; fi',
          ].join(' && '),
        ],
      });
      resolve(container);
    } catch (e) {
      await container.stop();
      reject(e);
    }
  });

const startNodeApp = (testId: string) =>
  new Promise(async (resolve, reject) => {
    await pull('node:current-alpine');

    const container = await docker.createContainer({
      name: `app_${testId}`,
      Image: 'node:current-alpine',
      AttachStderr: false,
      AttachStdout: false,
      Tty: true,
      WorkingDir: '/app',
      Cmd: ['tail', '-f', '/dev/null'],
      HostConfig: {
        AutoRemove: true,
        NetworkMode: `network_${testId}`,
        Binds: [`${path.join(process.cwd(), '/tests')}:/app`],
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [`network_${testId}`]: {
            Links: [`hasura_${testId}:hasura`],
          },
        },
      },
    });

    await container.start();

    try {
      await runExec(container, {
        AttachStderr: true,
        AttachStdout: true,
        Tty: true,
        Cmd: ['yarn', 'install'],
      });

      resolve(container);
    } catch (e) {
      await container.stop();
      reject(e);
    }
  });

const main = async () => {
  const testId = `test_${sha1(`${Date.now() + Math.random()}`)}`;

  const stopAll = async () => {
    const containers = await docker.listContainers();
    const networks = await docker.listNetworks();

    await Promise.all(
      containers
        .filter(({ Names }) =>
          Names.some(name => new RegExp(testId).test(name))
        )
        .map(({ Id }) => docker.getContainer(Id).stop())
    );
    return Promise.all(
      networks
        .filter(({ Name }) => new RegExp(testId).test(Name))
        .map(({ Id }) => docker.getNetwork(Id).remove())
    );
  };

  try {
    await docker.createNetwork({ Name: `network_${testId}` });

    await startPostgres(testId);
    await startHasura(testId);

    const app = await startNodeApp(testId);

    await runExec(app, {
      AttachStderr: true,
      AttachStdout: true,
      Tty: true,
      Cmd: ['yarn', 'test'],
    });

    await stopAll();
  } catch (e) {
    console.error(e);
    await stopAll();

    process.exit(1);
  }
};

main();
