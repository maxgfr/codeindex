/** A card that renders its title. */
export default class extends React.Component<Props> {
  render() {
    return this.props.title;
  }

  private measure(): number {
    return 0;
  }
}
