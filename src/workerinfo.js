const taskcluster = require('taskcluster-client');
const Entity      = require('azure-entities');
const assert      = require('assert');
const slugid      = require('slugid');
const debug       = require('debug')('workerinfo');

const DAY = 24 * 60 * 60 * 1000;
const RECENT_TASKS_LIMIT = 20;

const ignoreEntityAlreadyExists = (err) => {
  if (!err || err.code !== 'EntityAlreadyExists') {
    throw err;
  }
};

const expired = entity => Date.now() > new Date(entity.expires) - DAY;
const shouldUpdateLastDateActive = entity => Date.now() - new Date(entity.lastDateActive) > DAY / 4;

const updateExpiration = (entity, expires) => {
  if (expired(entity)) {
    entity.expires = expires;
  }
};

const updateLastDateActive = (entity) => {
  if (shouldUpdateLastDateActive(entity)) {
    entity.lastDateActive = new Date();
  }
};

class WorkerInfo {
  constructor(options) {
    assert(options);
    assert(options.Provisioner);
    this.Provisioner = options.Provisioner;
    this.WorkerType = options.WorkerType;
    this.Worker = options.Worker;

    // update `expires` values in Azure at this frequency; larger values give less accurate
    // expires times, but reduce Azure traffic.
    this.updateFrequency = '6 hours';
    this.nextUpdateAt = {};
  }

  /**
   * Mark a value as seen, only actually updating the Azure table row
   * occasionally. This takes the approach of updating the row immediately on
   * the first call, then not updating until `updateFrequency` has elapsed.
   * Thus the `expires` value on a row may be out-of-date by `updateFrequency`.
   *
   * Note that the cache is never purged of outdated entries; this assumes that
   * the process is restarted on a daily basis, so there is not too much time
   * for stale cache entries to accumulate.
   */
  async valueSeen(key, updateExpires) {
    let now = new Date();
    let nextUpdate = this.nextUpdateAt[key];
    if (!nextUpdate || nextUpdate < now) {
      this.nextUpdateAt[key] = taskcluster.fromNow(this.updateFrequency);

      await updateExpires();
    }
  }

  async seen(provisionerId, workerType, workerGroup, workerId) {
    const expires = workerId ? taskcluster.fromNow('1 day') : taskcluster.fromNow('5 days');

    const createEntry = async (entity, entry) => {
      try {
        await entity.create(entry);
      } catch (err) {
        ignoreEntityAlreadyExists(err);
      }
    };

    const promises = [];

    // provisioner seen
    if (provisionerId) {
      promises.push(this.valueSeen(provisionerId, async () => {
        // perform an Azure upsert, trying the update first as it is more common
        const provisioner = await this.Provisioner.load({provisionerId}, true);

        if (provisioner) {
          return provisioner.modify(entity => {
            updateExpiration(entity, expires);
            updateLastDateActive(entity);
          });
        }

        createEntry(this.Provisioner, {
          provisionerId,
          expires,
          description: '',
          stability: 'experimental',
          lastDateActive: new Date(),
        });
      }));
    }

    // worker-type seen
    if (provisionerId && workerType) {
      promises.push(this.valueSeen(`${provisionerId}/${workerType}`, async () => {
        // perform an Azure upsert, trying the update first as it is more common
        const wType = await this.WorkerType.load({provisionerId, workerType}, true);

        if (wType) {
          return wType.modify(entity => {
            updateExpiration(entity, expires);
            updateLastDateActive(entity);
          });
        }

        createEntry(this.WorkerType, {
          provisionerId,
          workerType,
          expires,
          lastDateActive: new Date(),
          description: '',
          stability: 'experimental',
        });
      }));
    }

    // worker  seen
    if (provisionerId && workerType && workerGroup && workerId) {
      promises.push(this.valueSeen(`${provisionerId}/${workerType}/${workerGroup}/${workerId}`, async () => {
        // perform an Azure upsert, trying the update first as it is more common
        const worker = await this.Worker.load({provisionerId, workerType, workerGroup, workerId}, true);

        if (worker) {
          try {
            return worker.modify(entity => updateExpiration(entity, expires));
          } catch (err) {
            throw err;
          }
        }

        const recentTasks = Entity.types.SlugIdArray.create();

        createEntry(this.Worker, {
          provisionerId,
          workerType,
          workerGroup,
          workerId,
          expires,
          recentTasks,
          disabled: false,
          firstClaim: new Date(),
        });
      }));
    }

    await Promise.all(promises);
  }

  async expire(now) {
    let count;

    debug('Expiring provisioners at: %s, from before %s', new Date(), now);
    count = await this.Provisioner.expire(now);
    debug('Expired %s provisioners', count);

    debug('Expiring worker-types at: %s, from before %s', new Date(), now);
    count = await this.WorkerType.expire(now);
    debug('Expired %s worker-types', count);

    debug('Expiring workers at: %s, from before %s', new Date(), now);
    count = await this.Worker.expire(now);
    debug('Expired %s workers', count);
  }

  async taskSeen(provisionerId, workerType, workerGroup, workerId, tasks) {
    // Keep track of most recent tasks of a worker
    const worker = await this.Worker.load({
      provisionerId,
      workerType,
      workerGroup,
      workerId,
    }, true);

    if (!tasks.length || !worker || worker.disabled) {
      return;
    }

    let existentTasks = worker.recentTasks.toArray();

    // Allocate more space if needed
    if (existentTasks.length && !worker.recentTasks.avail) {
      worker.recentTasks.realloc();
    }

    // realloc will not add more space if no items in the buffer. We'll need to create a new SlugIdArray
    const recentTasks = worker.recentTasks.avail ?
      worker.recentTasks :
      Entity.types.SlugIdArray.create();

    tasks.forEach((task, index) => {
      const taskId = tasks[index].status.taskId;

      if (!existentTasks.includes(taskId)) {
        if (existentTasks.length === RECENT_TASKS_LIMIT) {
          recentTasks.remove(existentTasks[0]);
          existentTasks = existentTasks.slice(1, RECENT_TASKS_LIMIT + 1);
        }

        existentTasks.push(taskId);
        recentTasks.push(taskId);
      }
    });

    await worker.modify(entity => {
      entity.recentTasks = recentTasks;
    });
  }
}

module.exports = WorkerInfo;
