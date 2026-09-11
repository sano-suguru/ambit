// A project-local factory returns a value whose type this project declares in
// a `.ts` file, not a declaration file. There is no package boundary to name,
// and the class behind it is code the analysis could in principle follow, so
// inventing a name here would hide that.
export class Widget {
  spin(): number {
    return 1;
  }
}

function makeWidget(): Widget {
  return new Widget();
}

const widget = makeWidget();

export function callsProjectFactoryResult(): number {
  return widget.spin();
}
