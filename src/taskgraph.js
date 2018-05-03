const _ = require('lodash');
const assert = require('assert');
const format = require('date-fns/format');
const logUpdate = require('log-update');
const {dots2: spinner} = require('cli-spinners');
const chalk = require('chalk');
const logSymbols = require('log-symbols');
const isStream = require('is-stream');
const isPromise = require('is-promise');
const isObservable = require('is-observable');
const figures = require('figures');
const stripAnsi = require('strip-ansi');
const cliTruncate = require('cli-truncate');
const unicodeProgress = require('unicode-progress');
const Observable = require('zen-observable');

class TaskGraph {
  constructor(tasks, options={}) {
    this.nodes = tasks.map(task => ({state: 'pending', task: {requires: [], provides: [], locks: [], ...task}}));
    this.renderer = options.renderer || (process.stdout.isTTY ? new ConsoleRenderer() : new LogRenderer());
    this.locks = options.locks || {};

    this.nodes.forEach(({task}) => {
      assert('title' in task, 'Task has no title');
      assert('run' in task, `Task ${task.title} has no run method`);
      assert(task.locks.every(l => l in this.locks), `Task ${task.title} has undefined locks`);
    });
  }

  /**
   * Run the graph.  This will return when all nodes in the graph are finished.
   * The optional `context` argument can be used to pre-populate some keys. It will
   * be modified in-place and returned.
   */
  async run(context={}) {
    let firstError = null;

    this.renderer.start(this.nodes);

    const nodeCanStart = node => {
      if (node.state !== 'pending') {
        return false;
      }

      if (!node.task.requires.every(k => k in context)) {
        return false;
      }

      if (!node.task.locks.every(l => this.locks[l].available())) {
        return false;
      }

      return true;
    };

    try {
      await new Promise((resolve, reject) => {
        const refresh = () => {
          let pendingCount = 0;

          // if an error has occurred, wait until there are no tasks running, then
          // reject with that error
          if (firstError) {
            if (Object.values(this.nodes).every(n => n.state !== 'running')) {
              reject(firstError);
            }
            return;
          }

          this.nodes.forEach(node => {
            if (nodeCanStart(node)) {
              this._runNode(node, context).catch(err => {
                if (!firstError) {
                  firstError = err;
                }
              }).then(refresh);
            }
          });
          if (Object.values(this.nodes).every(n => n.state === 'finished' || n.state === 'skipped')) {
            resolve();
          }
        };
        refresh();
      });
    } finally {
      this.renderer.stop();
    }

    return context;
  }

  async _runNode(node, context) {
    const {task} = node;

    const utils = {};
    utils.waitFor = value => {
      if (isStream(value)) {
        value = streamToLoggingObservable(value);
      }

      if (isObservable(value)) {
        value = new Promise((resolve, reject) => {
          value.subscribe({
            next: data => this.renderer.update(node, 'log', data),
            complete: resolve,
            error: reject,
          });
        });
      }

      if (isPromise(value)) {
        return value.then(utils.waitFor);
      }
      
      return value;
    };

    utils.skip = ({provides, reason}={}) => {
      node.state = 'skipped';
      this.renderer.update(node, 'state', 'skipped');
      this.renderer.update(node, 'skip', reason || 'skipped');
      return provides;
    };

    utils.status = status => {
      this.renderer.update(node, 'status', status);
    };

    utils.step = ({title}) => {
      this.renderer.update(node, 'step', {title});
    };

    node.state = 'running';
    this.renderer.update(node, 'state', 'running');

    node.task.locks.forEach(l => this.locks[l].acquire());
    try {
      const requirements = {};
      task.requires.forEach(k => requirements[k] = context[k]);

      let result;
      try {
        result = await task.run(requirements, utils);
      } catch (err) {
        node.state = 'failed';
        this.renderer.update(node, 'state', 'failed');
        this.renderer.update(node, 'fail', err);
        throw err;
      }

      // as a convenience, provide a single value as a simple 'true'
      if (!result) {
        assert(task.provides.length <= 1,
          `Task ${task.title} provides multiple results, but did not return any values`);
        result = task.provides.length === 1 ? {[task.provides[0]]: true} : {};
      }

      // check that the step provided what was expected
      Object.keys(result).forEach(key => {
        assert(!(key in context), `Task ${task.title} provided ${key}, but it has already been provided`);
        assert(task.provides.indexOf(key) !== -1, `Task ${task.title} provided unexpected ${key}`);
      });
      task.provides.forEach(key => {
        assert(key in result, `Task ${task.title} did not provide expected ${key}`);
      });
      Object.assign(context, result);

      if (node.state !== 'skipped') {
        node.state = 'finished';
        this.renderer.update(node, 'state', 'finished');
      }
    } finally {
      node.task.locks.forEach(l => this.locks[l].release());
    }
  }
}

module.exports.TaskGraph = TaskGraph;

class ConsoleRenderer {
  constructor() {
    this.progressBar = unicodeProgress({width: 30});
  }

  start(nodes) {
    this.nodes = nodes;
    // nodes are only displayed when they are running or finished
    this.displayed = [];
    this.interval = setInterval(() => this.render(), spinner.interval);
  }

  stop() {
    clearInterval(this.interval);
    this.render();
  }

  update(node, change, value) {
    if (change === 'state') {
      if (value === 'running') {
        node.started = new Date().getTime();
        this.displayed.push(node);
      }
    } else if (change === 'step') {
      if (!node.steps) {
        node.steps = [];
      }
      delete node.output;
      delete node.message;
      delete node.progress;
      node.steps.push(value);
    } else if (change === 'log') {
      if (!node.output) {
        node.output = [];
      }
      node.output.push(value.toString().trimRight());
      node.output = node.output.slice(-4);
    } else if (change === 'skip') {
      node.skipReason = value;
    } else if (change == 'status') {
      if (value.message) {
        node.message = value.message;
      }
      if (value.progress !== undefined) {
        node.progress = value.progress;
      }
    } else if (change == 'fail') {
      node.message = value.toString();
      // force a re-render since we will likely terminate soon (it is already
      // marked with status='fail')
      this.render();
    }
  }

  render() {
    const now = new Date().getTime();
    const logoutput = this.displayed.map(node => {
      let noderep = [];

      if (node.state === 'running') {
        const frameidx = Math.trunc((now - node.started) / spinner.interval) % spinner.frames.length;
        const frame = chalk.yellow(spinner.frames[frameidx]);
        noderep.push(`${frame} ${chalk.bold(node.task.title)}`);

        // show previous and current steps
        if (node.steps) {
          const last = node.steps.length - 1;
          node.steps.forEach((step, i) => {
            const title = chalk.bold(cliTruncate(step.title, process.stdout.columns - 4));
            noderep.push(` ${i === last ? frame : logSymbols.success} ${title}`);
          });
        }

        // render the node output, if any
        if (node.output) {
          const lines = node.output.map(line => {
            const logged = stripAnsi(cliTruncate(line, process.stdout.columns - 4));
            return ` ${chalk.cyan(figures.arrowRight)} ${logged}`;
          });
          noderep.push(`${lines.join('\n')}`);
        }

        // build a status line..
        let statusline = [];
        if ('progress' in node) {
          statusline.push(chalk.magenta.bgBlue(this.progressBar(node.progress)));
        }
        if (node.message) {
          let width = process.stdout.columns - 4;
          if ('progress' in node) {
            width -= 31;
          }
          statusline.push(`${chalk.bold(cliTruncate(node.message, width))}`);
        }
        if (statusline.length) {
          noderep.push(` ${chalk.cyan(figures.info)} ` + statusline.join(' '));
        }

      } else if (node.state === 'skipped') {
        noderep.push(`${logSymbols.info} ${chalk.bold(node.task.title)} (${node.skipReason || 'skipped'})`);
      } else if (node.state === 'failed') {
        const msg = node.message ? ` (${node.message})` : '';
        noderep.push(`${logSymbols.error} ${chalk.bold(node.task.title)}${msg}`);
      } else {
        noderep.push(`${logSymbols.success} ${chalk.bold(node.task.title)}`);
      }

      return noderep.join('\n');
    });

    const numFinished = this.displayed.filter(n => n.state != 'running').length;
    const pctFinished = Math.trunc(100 * numFinished / Object.keys(this.nodes).length);
    const progress = chalk.cyanBright(`${pctFinished}% finished`);
    logoutput.push(progress);

    logUpdate(logoutput.join('\n'));
  }
}

exports.ConsoleRenderer = ConsoleRenderer;

class LogRenderer {
  start(nodes) {
  }

  stop() {
  }

  update(node, change, value) {
    let output;
    if (change === 'state') {
      output = `${node.task.title}: ${value}`;
    } else if (change === 'log') {
      output = `${node.task.title}: ${value}`;
    } else if (change === 'step') {
      output = `${node.task.title}: start step ${value.title}`;
    } else if (change === 'skip') {
      output = `${node.task.title}: skip - ${value}`;
    } else if (change === 'fail') {
      output = `${node.task.title}: fail: ${value}`;
    } else if (change === 'status') {
      if (value.message) {
        output = `${node.task.title}: ${value.message}`;
      }
      // (silently ignore progress updates)
    }

    if (output) {
      const timestamp = format(new Date(), 'HH:mm:ss');
      console.log(`[${timestamp}] ${output}`);
    }
  }
}

exports.LogRenderer = LogRenderer;

/**
 * Convert a textual byte stream to an observable that calls next() for each
 * line, with newlines stripped.
 *
 * Object streams are handled by converting each object into a string.
 */
const streamToLoggingObservable = stream => {
  return new Observable(observer => {
    let buffer = Buffer.alloc(0);
    const onData = data => {
      if (!Buffer.isBuffer(data)) {
        data = Buffer.from(data.toString() + '\n');
      }
      buffer = Buffer.concat([buffer, data]);
      let i;
      while ((i = buffer.indexOf(0x0a)) !== -1) {
        observer.next(buffer.slice(0, i).toString());
        buffer = buffer.slice(i + 1);
      }
    };
    const onError = err => {
      cleanup();
      observer.error(err);
    };
    const onEnd = res => {
      if (buffer.length > 0) {
        observer.next(buffer.toString());
      }
      cleanup();
      observer.complete(res);
    };
    const cleanup = () => {
      try {
        stream.removeListener('data', onData);
      } catch (err) {}
      try {
        stream.removeListener('error', onError);
      } catch (err) {}
      try {
        stream.removeListener('end', onEnd);
      } catch (err) {}
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
};

class Lock {
  constructor(N) {
    this.N = N;
    this.n = 0;
  }

  available() {
    return this.n < this.N;
  }

  acquire() {
    assert(this.n < this.N);
    this.n += 1;
  }

  release() {
    this.n -= 1;
  }
}

exports.Lock = Lock;
