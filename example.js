let TaskGraph;
try {
  TaskGraph = require('console-taskgraph').TaskGraph;
} catch (err) {
  TaskGraph = require('.').TaskGraph;
}
const assume = require('assume');
const fs = require('fs');
const Observable = require('zen-observable');

const delayTask = ({delay, skip, prog, message, ...task}) => {
  task.run = async (requirements, utils) => {
    let progress = 0;
    if (message) {
      utils.status({message});
    }
    const interval = setInterval(() => {
      utils.status({progress: progress});
      progress += 5;
    }, 100);
    await new Promise(resolve => setTimeout(resolve, delay));
    clearInterval(interval);
    const res = {};
    for (const k of task.provides) {
      res[k] = true;
    }
    if (skip) {
      return utils.skip(res);
    } else {
      return res;
    }
  };
  return task;
};

const streamTask = ({filename, ...task}) => {
  task.run = async (requirements, {waitFor, status}) => {
    await waitFor(fs.createReadStream(filename));
  };
  return task;
};

const observableTask = ({...task}) => {
  task.run = async (requirements, {waitFor, status, step}) => {
    status({message: 'greeting you..'});
    await waitFor(new Observable(observer => {
      setTimeout(() => observer.next('hello'), 0);
      setTimeout(() => step({title: 'modifiers'}), 400);
      setTimeout(() => observer.next('cruel'), 500);
      setTimeout(() => observer.next('inhospitable'), 1000);
      setTimeout(() => step({title: 'more modifiers'}), 1100);
      setTimeout(() => observer.next('fundamentally'), 1500);
      setTimeout(() => observer.next('inhumane'), 2000);
      setTimeout(() => step({title: 'object'}), 2500);
      setTimeout(() => observer.next('world'), 2500);
      setTimeout(() => observer.complete(), 3500);
    }));
  };
  return task;
};

const nodes = [
  delayTask({title: 'D1', requires: [], provides: ['1'], delay: 1000}),
  delayTask({title: 'D2', requires: ['1'], provides: ['2', '3'], delay: 800, message: 'hi'}),
  delayTask({title: 'D3', requires: ['1'], provides: ['4', '5'], delay: 1500, prog: true}),
  delayTask({title: 'D4', requires: ['3', '4'], provides: ['6'], delay: 1000, skip: true}),
  delayTask({title: 'D5', requires: ['4', '6'], provides: ['7'], delay: 1000}),
  streamTask({title: 'D6', requires: ['1'], provides: [], filename: 'README.md'}),
  observableTask({title: 'D7', requires: ['1'], provides: []}),
];

const graph = new TaskGraph(nodes);
graph.run().catch(err => {
  console.error(err);
  process.exit(1);
});
