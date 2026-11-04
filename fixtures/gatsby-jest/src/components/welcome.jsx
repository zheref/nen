import React from "react";
import { Link } from "gatsby";
import styles from "./welcome.module.css";
export function Welcome({ name }) {
  return <h1 className={styles.heading}><Link to="/">Hello {name || "visitor"}</Link></h1>;
}
